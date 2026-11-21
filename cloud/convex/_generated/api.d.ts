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
import type * as agent_component from "../agent/component.js";
import type * as agent_constants from "../agent/constants.js";
import type * as agent_hydrate from "../agent/hydrate.js";
import type * as agent_ledger from "../agent/ledger.js";
import type * as agent_secrets from "../agent/secrets.js";
import type * as agent_turn from "../agent/turn.js";
import type * as auth from "../auth.js";
import type * as authConstants from "../authConstants.js";
import type * as blobOwner from "../blobOwner.js";
import type * as chats from "../chats.js";
import type * as composio_actions from "../composio/actions.js";
import type * as composio_client from "../composio/client.js";
import type * as composio_connectionStore from "../composio/connectionStore.js";
import type * as composio_connections from "../composio/connections.js";
import type * as composio_constants from "../composio/constants.js";
import type * as composio_expire from "../composio/expire.js";
import type * as composio_returnTarget from "../composio/returnTarget.js";
import type * as composio_server from "../composio/server.js";
import type * as composio_webhook from "../composio/webhook.js";
import type * as composio_webhookRoute from "../composio/webhookRoute.js";
import type * as crons from "../crons.js";
import type * as domainRecords from "../domainRecords.js";
import type * as domainSchema from "../domainSchema.js";
import type * as domainValues from "../domainValues.js";
import type * as files from "../files.js";
import type * as functions from "../functions.js";
import type * as http from "../http.js";
import type * as messages from "../messages.js";
import type * as runs from "../runs.js";
import type * as sandboxes from "../sandboxes.js";
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
import type * as workflows_turnCommit from "../workflows/turnCommit.js";
import type * as workflows_turnState from "../workflows/turnState.js";
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
  "agent/component": typeof agent_component;
  "agent/constants": typeof agent_constants;
  "agent/hydrate": typeof agent_hydrate;
  "agent/ledger": typeof agent_ledger;
  "agent/secrets": typeof agent_secrets;
  "agent/turn": typeof agent_turn;
  auth: typeof auth;
  authConstants: typeof authConstants;
  blobOwner: typeof blobOwner;
  chats: typeof chats;
  "composio/actions": typeof composio_actions;
  "composio/client": typeof composio_client;
  "composio/connectionStore": typeof composio_connectionStore;
  "composio/connections": typeof composio_connections;
  "composio/constants": typeof composio_constants;
  "composio/expire": typeof composio_expire;
  "composio/returnTarget": typeof composio_returnTarget;
  "composio/server": typeof composio_server;
  "composio/webhook": typeof composio_webhook;
  "composio/webhookRoute": typeof composio_webhookRoute;
  crons: typeof crons;
  domainRecords: typeof domainRecords;
  domainSchema: typeof domainSchema;
  domainValues: typeof domainValues;
  files: typeof files;
  functions: typeof functions;
  http: typeof http;
  messages: typeof messages;
  runs: typeof runs;
  sandboxes: typeof sandboxes;
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
  "workflows/turnCommit": typeof workflows_turnCommit;
  "workflows/turnState": typeof workflows_turnState;
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
  agent: import("@convex-dev/agent/_generated/component.js").ComponentApi<"agent">;
};
