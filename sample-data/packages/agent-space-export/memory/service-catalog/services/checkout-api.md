---
name: services/checkout-api
description: What checkout-api does, where its logs are and who owns it. Read when an alert or ticket names checkout-api.
---

checkout-api takes the cart, holds seats through seat-map-service and charges the card through payments-gateway. Logs: /anyco/prod/checkout-api. Owner: team-checkout.

A 5xx from payments-gateway shows up here as HTTP 502 with error code PGW_UPSTREAM.

Memory: service-catalog/services/checkout-api
Review this memory when an incident shows it is wrong.
