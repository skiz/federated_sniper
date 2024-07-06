# Server Notes

Use yarn.

Use redis-cli to configure system.

## add key to pool
`sadd key:{key_id}:pools {pool_id}`

## Pool Design
key:{key_id}:pools = pool id access list.  (set)
pools:{pool_id}:meta = info about pool.

(unimp) pools:{pool_id}:slots = active slots in this pool.
pool:{pool_id}:targets = set of target ids

## fixtures


## reviewing fixtures
smembers key:test:pools
hgetall pools:123:meta
hgetall targets:B0815Y8J9N
smembers pools:123:targets
