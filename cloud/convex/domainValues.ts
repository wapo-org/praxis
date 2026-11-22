import {
  ChatSchema, MessageSchema, type Chat, type ConversationSetup, type MessagePart,
} from '@praxis/protocol';
import type {Doc} from './_generated/dataModel.js';

function encodeTools(tools: ConversationSetup['tools']) {
  return tools.map(tool => ({...tool, inputSchema: JSON.stringify(tool.inputSchema)}));
}

function decodeTools(tools: NonNullable<Doc<'chats'>['value']['setup']>['tools']) {
  return tools.map(tool => ({...tool, inputSchema: JSON.parse(tool.inputSchema)}));
}

export function encodeChat({setup, ...chat}: Chat): Doc<'chats'>['value'] {
  if (!setup) return chat;
  const {tools, hiddenTools, ...fields} = setup;
  return {
    ...chat,
    setup: {...fields, tools: encodeTools(tools), ...(hiddenTools && {hiddenTools: encodeTools(hiddenTools)})},
  };
}

export function decodeChat({setup, ...chat}: Doc<'chats'>['value']): Chat {
  if (!setup) return chat;
  const {tools, hiddenTools, ...fields} = setup;
  return ChatSchema.parse({...chat, setup: {
    ...fields, tools: decodeTools(tools), ...(hiddenTools && {hiddenTools: decodeTools(hiddenTools)}),
  }});
}

// Convex validators cannot express recursive JSON, so protocol-validated open fields are stored as JSON text.
export function encodePart({content, ...part}: MessagePart) {
  return {...part, ...(content && {content: JSON.stringify(content)})};
}

export function decodeMessage({parts, raw, ...message}: Doc<'messages'>['value']) {
  return MessageSchema.parse({
    ...message,
    parts: parts.map(({content, ...part}) => ({...part, ...(content && {content: JSON.parse(content)})})),
    ...(raw && {raw: {...raw, data: JSON.parse(raw.data)}}),
  });
}
