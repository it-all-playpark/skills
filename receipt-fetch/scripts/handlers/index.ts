import type { HandlerContext, FetchResult } from "./base.js";
import { MoneyForwardHandler } from "./moneyforward.js";
import { JREastHandler } from "./jr-east.js";
import { AmazonHandler } from "./amazon.js";

export type { HandlerContext, FetchResult };

export function createHandler(
  serviceName: string,
  ctx: HandlerContext
): MoneyForwardHandler | JREastHandler | AmazonHandler {
  switch (serviceName) {
    case "moneyforward":
      return new MoneyForwardHandler(ctx);
    case "jr-east":
      return new JREastHandler(ctx);
    case "amazon":
      return new AmazonHandler(ctx);
    default:
      throw new Error(`Unknown service: ${serviceName}`);
  }
}

export const supportedServices = ["moneyforward", "jr-east", "amazon"] as const;
export type SupportedService = (typeof supportedServices)[number];

export function isSupported(service: string): service is SupportedService {
  return supportedServices.includes(service as SupportedService);
}
