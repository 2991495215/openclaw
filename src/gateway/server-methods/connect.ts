import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { respondError } from "./response.js";
import type { GatewayRequestHandlers } from "./types.js";

export const connectHandlers: GatewayRequestHandlers = {
  connect: ({ respond }) => {
    respondError(respond, ErrorCodes.INVALID_REQUEST, "connect is only valid as the first request");
  },
};
