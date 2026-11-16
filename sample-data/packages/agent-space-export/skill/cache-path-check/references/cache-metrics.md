# Cache metrics for seat holds

| Metric | What it shows | Worry when |
|---|---|---|
| `evicted_keys` | Keys removed to make room | Above zero while holds vanish |
| `used_memory` | Memory in use | Close to the maximum |
| `curr_items` | Keys held now | Far below the active hold count |
| `cache_hit_rate` | Share of reads that found a key | Falls while traffic rises |
| `maxmemory-policy` (parameter group) | What the cache removes when full | `allkeys-lru` instead of `volatile-ttl` |

Hold TTL is 10 minutes. A hold that is gone before its TTL passed was evicted or deleted.
