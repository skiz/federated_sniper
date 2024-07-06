var running = false;
var config = {};
var ticker = null;
var target = -1;
var next_action_ts = 0;
var cart_timers = [];
var websocket = undefined;
var ping_ticker = null;
const TICKER_MS = 1000;
const PING_TICKER_MS = 30000;
var alertAudio = new Audio(chrome.runtime.getURL("./audio/acquired.mp3"));
var checkoutAudio = new Audio(chrome.runtime.getURL("./audio/horn.mp3"));

// TODO: Randomize target selection?
function nextTarget() {
  target++;
  if (target >= config.targets.length) {
    target = 0;
  }
  return config.targets[target];
}

function domExec(tabId, code, success) {
  chrome.tabs.executeScript(tabId, { code: code, runAt: "document_end" }, function (result) {
    success(result[0]);
  });
}

function waitForDom(tabId, tag, cb) {
  console.log("waitForDom");
  let t = setInterval(function () {
    domExec(tabId, `(function(){ return document.querySelector('${tag}') != null })()`, function (success) {
      cb(success);
      clearInterval(t);
    });
  }, 500);
}

function checkAvailability(target, tabId, skipAlert) {
  waitForDom(tabId, '#olpOfferList', function () {
    console.log("domExec");
    domExec(tabId, `
        (function isAvailable(){
          const availContent = document.querySelector("#olpOfferList");
          const fail_text = "Currently, there are no sellers that can deliver this item to your location.";
          if(availContent && availContent != fail_text) {
            let priceContent = document.querySelector(".olpOfferPrice");
            if (priceContent) {
              return {price: priceContent.innerText};
            }
          }
        })()`, function (result) {
      if (result) {
        price = parseFloat(result.price.replace(/[^\d.]/g,''));
        if (target.max_price > 0 && price < target.max_price) {
          if (!skipAlert) {
            sendPoolNotification(target, price);
          }
        }
        if (target.cart) {
          if (config.audio_alert) {
            alertAudio.play();
          }
          addToCart(target, tabId);
        }
      }
    });
  });
}

function addToCart(target, tabId) {
  domExec(tabId, `
      (function addToCart(){
        document.querySelector("input.a-button-input").click();
      })()`, function (result) {
    waitForDom(tabId, 'div.huc-v2-color-success', function () {
      domExec(tabId, `
              (function added(){
                let d = document.querySelector("div.huc-v2-color-success");
                return d && d.innerText == "Added to Cart";
             })()`, function (added) {
        if (added) {
          proceedToCheckout(target, tabId);
        }
      });
    });
  });
}

function proceedToCheckout(target, tabId) {
  domExec(tabId, `
      (function proceedToCheckout(){
        let d = document.querySelector("span#hlb-ptc-btn a")
        if (d) { d.click(); return true; }
      })()`,
    function (result) {
      if (result) {
        if (target.autobuy > 0 && target.autobuy < target.bought) {
          waitForDom(tabId, 'input[name=placeYourOrder1]', function () {
            domExec(tabId, `
              (function placeOrder(){

                // If not logged in we cannot checkout....
                if (document.querySelector("input#ap_email")) {
                  alert('you must be logged in for automatic purchases!');
                  return;
                }

                document.querySelector("input[name=placeYourOrder1]").click();
                return true;
             })()`, function (ordered) {
              if (ordered && config.audio_alert) {
                checkoutAudio.play();
                target.bought ||= 0;
                target.bought += 1;
              }
            })
          });
        }
      }
    });
}

function tick() {
  if (Date.now() < next_action_ts) {
    return;
  }

  // look for any existing target tab
  let target = nextTarget();
  let existing = null;
  chrome.tabs.query({}, function (tabs) {
    existing = tabs.find(function (t) { return t.url == target.url });

    if (existing) {
      // DO WE *NEED* TO SEE THEM? Perhaps on success?
      // chrome.tabs.update(existing.id, { active: true });
      chrome.tabs.reload(existing.id);
      checkAvailability(target, existing.id);
    } else {
      openNewTab(target.url, function (tab) {
        checkAvailability(target, tab.id);
      });
    }

  });

  // schedule next action
  next_action_ts = Date.now()
    + parseInt(config.min_delay_ms)
    + Math.floor(Math.random() * parseInt(config.random_skew_ms));
}

function openNewTab(url, fn) {
  chrome.tabs.create({ url: url }, function (tab) {
    fn(tab);
  });
}

function createWebSocketConnection() {
  if ('WebSocket' in window) {
    connectSocket(`ws://${config.host}/api/pool`);
  }
}

function connectSocket(host) {
  if (websocket === undefined) {
    websocket = new WebSocket(host);
  }

  websocket.onopen = function () {
    websocket.send(JSON.stringify({ key: config.access_key, pool: config.pool }));
    ping_ticker = setInterval(function () {
      websocket.send('{"ping":1}');
    }, PING_TICKER_MS);
  };

  websocket.onmessage = function (event) {
    var received_msg = JSON.parse(event.data);
    console.log(received_msg);
    if (received_msg.price) {
      let target = config.targets.find(function(f) { return !!f.cart && f.identifier == received_msg.identifier });
      if (target) {
        chrome.tabs.query({}, function (tabs) {
          existing = tabs.find(function (t) { return t.url == target.url });
          if (existing) {
            chrome.tabs.update(existing.id, { active: true });
            chrome.tabs.reload(existing.id);
            checkAvailability(target, existing.id, skipAlert=true);
          } else {
            openNewTab(target.url, function (tab) {
              checkAvailability(target, tab.id, skipAlert=true);
            });
          }
        });
      }
    }
  }

  websocket.onclose = function () {
    websocket = undefined;
    if (ping_ticker) {
      clearInterval(ping_ticker);
      ping_ticker = null;
    }
    if (config.host && ticker) {
      createWebSocketConnection;
    }
  };
}

function sendPoolNotification(target, price) {
  if (websocket) {
    websocket.send(JSON.stringify({
      pool: config.pool,
      identifier: target.identifier,
      price: price
    }));
  }
}

function closeWebSocketConnection() {
  if (websocket != null || websocket != undefined) {
    websocket.close();
    websocket = undefined;
  }
}

chrome.runtime.onInstalled.addListener(function () {
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    switch (message.action) {

      case "start":
        last_ts = Date.now();
        if (ticker == null) {
          config = message.config;
          ticker = setInterval(tick, TICKER_MS);
          sendResponse("starting...");
          createWebSocketConnection();
        }
        break;

      case "stop":
        if (ticker != null) {
          sendResponse("stopping...");
          clearTimeout(ticker);
          ticker = null;
          closeWebSocketConnection();
        }
        break;

      default:
        sendResponse("unhandled action!");
    }
  });
});

