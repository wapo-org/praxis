/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as account from "../account.js";
import type * as accountOwner from "../accountOwner.js";
import type * as accountRecovery from "../accountRecovery.js";
import type * as accountTables from "../accountTables.js";
import type * as auth from "../auth.js";
import type * as authConstants from "../authConstants.js";
import type * as blobOwner from "../blobOwner.js";
import type * as composio_connections from "../composio/connections.js";
import type * as composio_constants from "../composio/constants.js";
import type * as composio_expire from "../composio/expire.js";
import type * as composio_schema from "../composio/schema.js";
import type * as composio_webhook from "../composio/webhook.js";
import type * as composio_webhookRoute from "../composio/webhookRoute.js";
import type * as crons from "../crons.js";
import type * as files from "../files.js";
import type * as functions from "../functions.js";
import type * as http from "../http.js";
import type * as runs from "../runs.js";
import type * as search from "../search.js";
import type * as store from "../store.js";
import type * as tools from "../tools.js";
import type * as turns from "../turns.js";
import type * as uploads from "../uploads.js";
import type * as users from "../users.js";
import type * as webTools from "../webTools.js";
import type * as workflows_agentRun from "../workflows/agentRun.js";
import type * as workflows_constants from "../workflows/constants.js";
import type * as workflows_purge from "../workflows/purge.js";
import type * as workflows_validators from "../workflows/validators.js";
import type * as zodValidator from "../zodValidator.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  account: typeof account;
  accountOwner: typeof accountOwner;
  accountRecovery: typeof accountRecovery;
  accountTables: typeof accountTables;
  auth: typeof auth;
  authConstants: typeof authConstants;
  blobOwner: typeof blobOwner;
  "composio/connections": typeof composio_connections;
  "composio/constants": typeof composio_constants;
  "composio/expire": typeof composio_expire;
  "composio/schema": typeof composio_schema;
  "composio/webhook": typeof composio_webhook;
  "composio/webhookRoute": typeof composio_webhookRoute;
  crons: typeof crons;
  files: typeof files;
  functions: typeof functions;
  http: typeof http;
  runs: typeof runs;
  search: typeof search;
  store: typeof store;
  tools: typeof tools;
  turns: typeof turns;
  uploads: typeof uploads;
  users: typeof users;
  webTools: typeof webTools;
  "workflows/agentRun": typeof workflows_agentRun;
  "workflows/constants": typeof workflows_constants;
  "workflows/purge": typeof workflows_purge;
  "workflows/validators": typeof workflows_validators;
  zodValidator: typeof zodValidator;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  auth: import("@convex-dev/auth/_generated/component.js").ComponentApi<"auth">;
  authPassword: import("@convex-dev/auth/components/password/_generated/component.js").ComponentApi<"authPassword">;
  authEmail: import("@convex-dev/auth/components/email/_generated/component.js").ComponentApi<"authEmail">;
  resend: import("@convex-dev/resend/_generated/component.js").ComponentApi<"resend">;
  authGoogle: import("@convex-dev/auth/components/google/_generated/component.js").ComponentApi<"authGoogle">;
  workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
};
