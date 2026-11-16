---
name: services/seat-map-service
description: What seat-map-service does, how seat holds are stored and who owns it. Read when seat holds or the seat map misbehave.
---

seat-map-service serves the venue seat map and seat holds. Holds live in the seat-hold-cache Redis cluster (cluster mode, 3 shards) with a 10-minute TTL. Owner: team-venue.

Memory: service-catalog/services/seat-map-service
Review this memory when an incident shows it is wrong.
