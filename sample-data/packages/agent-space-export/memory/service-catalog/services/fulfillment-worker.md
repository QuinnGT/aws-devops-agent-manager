---
name: services/fulfillment-worker
description: How fulfillment-worker consumes order-events and who owns it. Read when tickets or confirmation emails are late.
---

fulfillment-worker consumes the order-events topic (12 partitions), issues tickets and asks notification-service to send the confirmation email. Owner: team-fulfillment.

Consumer lag on one partition while the others are at zero means a stuck message, not load.

Memory: service-catalog/services/fulfillment-worker
Review this memory when an incident shows it is wrong.
