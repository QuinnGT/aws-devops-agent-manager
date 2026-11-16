/**
 * Plans module entry point. Every write to an Agent
 * Space goes through a plan: createPlan inserts it and starts its live-space
 * check; the apply job writes it. Other modules import createPlan from here
 * and mock this module in their tests.
 */
export * from "./contract";
export { createPlan } from "./create";
export { notifyPlanApplied, onPlanApplied, type PlanAppliedEvent, type PlanAppliedHook } from "./hooks";
