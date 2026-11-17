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
import type * as auth from "../auth.js";
import type * as authClerk from "../authClerk.js";
import type * as blobOwner from "../blobOwner.js";
import type * as files from "../files.js";
import type * as functions from "../functions.js";
import type * as http from "../http.js";
import type * as runs from "../runs.js";
import type * as search from "../search.js";
import type * as store from "../store.js";
import type * as tools from "../tools.js";
import type * as turns from "../turns.js";
import type * as uploads from "../uploads.js";
import type * as workflows_agentRun from "../workflows/agentRun.js";
import type * as workflows_constants from "../workflows/constants.js";
import type * as workflows_validators from "../workflows/validators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  account: typeof account;
  auth: typeof auth;
  authClerk: typeof authClerk;
  blobOwner: typeof blobOwner;
  files: typeof files;
  functions: typeof functions;
  http: typeof http;
  runs: typeof runs;
  search: typeof search;
  store: typeof store;
  tools: typeof tools;
  turns: typeof turns;
  uploads: typeof uploads;
  "workflows/agentRun": typeof workflows_agentRun;
  "workflows/constants": typeof workflows_constants;
  "workflows/validators": typeof workflows_validators;
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
  workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
};
