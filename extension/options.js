var defaultConfig = {
  access_key: "enter your key here",
  host: "butters.skizzles.net:4200",
  pool: null,
  targets: [],
  min_delay_ms: 5001,
  random_skew_ms: 10001,
  audio_alert: true,
  max_spend: 0.0,
  total_spent: 0.0
};

var defaultTarget = {
  monitor: true,
  cart: false,
  autobuy: 0,
  max_buy: 0 //TODO: rename to max_price
}

var config = {};
var logDiv = document.querySelector("div#log")
const MAX_LOG_LINES = 10;

function log(text) {
  if (logDiv.children.length > MAX_LOG_LINES) {
    logDiv.children[0].remove();
  }
  let line = document.createElement("span");
  line.innerText = text;
  logDiv.append(line);
}

function saveConfig(success) {
  console.log('saved');
  config.host = document.querySelector("input[name=host]").value;
  config.pool = document.querySelector("select[name=pool]").value;
  config.access_key = document.querySelector("input[name=access_key]").value;
  config.min_delay_ms = document.querySelector("input[name=min_delay_ms]").value;
  config.random_skew_ms = document.querySelector("input[name=random_skew_ms]").value;
  config.max_spend = document.querySelector("input[name=max_spend]").value;
  config.audio_alert = document.querySelector("input[name=audio_alerts]").checked;
  chrome.storage.local.set({ "cfg": config }, function () {
    if (typeof success === "function") {
      success();
    }
  });
}

function loadConfig() {
  chrome.storage.local.get("cfg", function (data) {
    if (data['cfg']) {
      config = { ...config, ...defaultConfig };
      config = { ...config, ...data['cfg'] };
      document.querySelector("input[name=host]").value = config.host;
      document.querySelector("input[name=access_key]").value = config.access_key;
      document.querySelector("input[name=min_delay_ms]").value = config.min_delay_ms;
      document.querySelector("input[name=random_skew_ms]").value = config.random_skew_ms;
      document.querySelector("input[name=audio_alerts]").checked = config.audio_alert;
      document.querySelector("input[name=max_spend]").value = config.max_spend;
    }
  });
}

function toggleUpdatePools(force_disable) {
  let button = document.getElementById('update_pools');
  button.disabled = (
    force_disable
    || document.querySelector("input[name=host]").value == ""
    || document.querySelector("input[name=access_key]").value == ""
  );
}

var xhr = (function () {
  var xhr = new XMLHttpRequest();
  return function (method, url, callback) {
    xhr.timeout = 5000;
    
    xhr.onreadystatechange = function () {
      if (xhr.readyState === 4) {
        callback(xhr.responseText, xhr.status);
      }
    };
    xhr.ontimeout = function () {
      callback("", 408);
    }
    xhr.open(method, url);
    xhr.setRequestHeader('Authorization', 'Bearer ' + config.access_key);
    xhr.send();
  };
})();

function loadPools(success, error) {
  toggleUpdatePools(true);
  log('loading pools...');
  xhr('GET', `http://${config.host}/api/pools.json`, function (data, status) {
    toggleUpdatePools();
    if (status != 200) {
      log('failed to load pools ' + status);
      return;
    }
    return success(JSON.parse(data));
  });
}

function loadTargets(pool_id, success, error) {
  log('loading targets...');
  xhr('GET', `http://${config.host}/api/targets.json?pool_id=${pool_id}`, function (data, status) {
    toggleUpdatePools();
    if (status != 200) {
      log('failed to load targets ' + status);
      return;
    }
    return success(JSON.parse(data));
  });
}

function updateTargetRow(e, row) {
  if (e.target == row.querySelector('select.buy') && row.querySelector('select.buy').selectedIndex > 0) {
    row.querySelector('input.monitor').checked = true;
    row.querySelector('input.cart').checked = true;
  }

  if (e.target == row.querySelector('input.cart')) {
    row.querySelector('input.monitor').checked = true;
  }

  if (!row.querySelector('input.monitor').checked) {
    row.querySelector('input.cart').checked = false;
    document.querySelector('select.buy').selectedIndex = 0;
  }

  if (row.querySelector('input.cart').checked) {
    row.querySelector('input.max').disabled = false;
  } else {
    row.querySelector('input.max').disabled = true;
    row.querySelector('select.buy').selectedIndex = 0;
  }
 /*
  if (row.querySelector('select.buy').selectedIndex == 0) {
    row.querySelector('input.max').disabled = true;
  } else {
    row.querySelector('input.max').disabled = false;
  }
  */

  let target_id = e.target.parentElement.parentElement.className;

  let target = config.targets.find(function (e) { return e.identifier == target_id });
  if (target) {
    target.monitor = row.querySelector('input.monitor').checked;
    target.cart = row.querySelector('input.cart').checked;
    target.autobuy = parseInt(row.querySelector('select.buy').value);
    target.max_buy = parseFloat(row.querySelector('input.max').value);
  }
  saveConfig();
}

init = function () {

  // Disable the config form submit
  document.getElementById('cform').onsubmit = function () {
    return false;
  }

  document.getElementById('cform').onkeyup = function () {
    toggleUpdatePools();
  }

  // Load stored configuration if available
  loadConfig();

  // Update pools when requested
  let button = document.getElementById('update_pools');
  button.addEventListener('click', function () {
    document.querySelector('button[name=start]').disabled = true;
    saveConfig();
    loadPools(function (pools) {
      let pool = document.querySelector("select[name=pool]");
      document.querySelector("tbody").replaceChildren();
      pool.replaceChildren();
      for (p in pools) {
        let item = pools[p];
        let optElement = document.createElement("option");
        optElement.value = item.id;
        optElement.disabled = (item.status == 0);
        optElement.innerText = item.name + ' (' + item.slots + ')';
        pool.appendChild(optElement);
      }
      pool.disabled = false;
    }, err = function (err) {
      log("unable to load remote pools.", err);
    });
  });

  // Load targets for a pool change.
  let pool = document.querySelector("select[name=pool]");
  pool.addEventListener('change', function () {
    let pool_id = document.querySelector("select[name=pool]").value;
    loadTargets(pool_id, function (targets) {
      config.targets = targets;
      for(i in targets) {
        targets[i] = {...defaultTarget, ...targets[i]}
      }
      let targetBody = document.querySelector("table#targets tbody");
      let tbody = document.createElement("tbody");
      for (i in targets) {
        let d = targets[i];
        d.max_price ||= 0.0;

        let monitor = document.createElement("input");
        monitor.type = "checkbox";
        monitor.classList.add("monitor");
        monitor.checked = true;
        monitor.name = d.identifier + "_monitor";
        monitor.value = d.identifier;

        let cart = document.createElement("input");
        cart.classList.add("cart");
        cart.type = "checkbox";
        cart.name = d.identifier + "_cart";

        let buy = document.createElement("select");
        buy.classList.add("buy");
        buy.name = d.identifier + "_buy";
        for (i = 0; i < 10; i++) {
          let option = document.createElement("option")
          option.text = i;
          buy.add(option);
        }

        let max_buy = document.createElement("input")
        max_buy.classList.add("max");
        max_buy.type = "text"
        max_buy.disabled = true;
        max_buy.name = d.identifier + "_max";
        max_buy.style['width'] = '60px';
        max_buy.value = d.max_price || 0.00;

        let row = document.createElement("tr");
        row.classList.add(d.identifier);

        let td_m = document.createElement("td");
        td_m.appendChild(monitor);
        row.appendChild(td_m);

        let td_ct = document.createElement("td");
        td_ct.appendChild(cart);
        row.appendChild(td_ct);

        let td_b = document.createElement("td");
        td_b.appendChild(buy);
        row.appendChild(td_b);

        let td_id = document.createElement("td");
        td_id.innerText = d.identifier;
        row.appendChild(td_id);

        let td_cat = document.createElement("td");
        td_cat.innerText = d.category;
        row.appendChild(td_cat);

        let td_p = document.createElement("td");
        let td_a = document.createElement("a");
        td_a.innerText = d.product;
        td_a.href = d.url;
        td_a.target = '_blank';
        td_p.appendChild(td_a);
        row.appendChild(td_p);

        let td_mb = document.createElement("td");
        td_mb.appendChild(max_buy);
        row.appendChild(td_mb);

        let td_mp = document.createElement("td");
        console.log(d.max_price);
        td_mp.innerText = "$" + parseFloat(d.max_price ||0).toFixed(2);
        row.appendChild(td_mp);

        row.addEventListener('change', function (e) {
          updateTargetRow(e, row);
        })

        tbody.appendChild(row);
      }
      targetBody.replaceWith(tbody);
      document.querySelector('button[name=start]').disabled = false;
    });
  });

  // Handle start/stop.
  let start = document.querySelector("button[name=start]");
  let stop = document.querySelector("button[name=stop]");

  start.addEventListener('click', function () {
    saveConfig();
    start.disabled = true;
    let clean_config = Object.assign({}, config);
     clean_config.targets = clean_config.targets.filter(function(t){return t.monitor })
    chrome.runtime.sendMessage({ action: "start", config: clean_config }, function (response) {
      log(response);
      start.disabled = true;
      stop.disabled = false;
    })
  })

  stop.addEventListener('click', function () {
    stop.disabled = true;
    chrome.runtime.sendMessage({ action: "stop" }, function (response) {
      log(response);
      start.disabled = false;
      stop.disabled = true;
    })
  })
}();

// Logging channel
chrome.runtime.onMessage.addListener(
  function (request, sender, sendResponse) {
    console.log(sender.tab ?
      "from a content script:" + sender.tab.url :
      "from the extension");
    if (request.action === "log" && request.text) {
      log(request.text);
    }
    sendResponse({ ok: true });
  }
);

