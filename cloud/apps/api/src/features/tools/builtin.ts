import {toolsState} from './state.js';
import {skillAuthoringTools, MAX_SKILL_FILE_BYTES} from './authoring.js';
import {z} from 'zod';
import {SkillSchema, type JsonValue} from '@praxis/protocol';
import type {FeatureContext, FeatureTool} from '../../contracts.js';
import {ApiError} from '../../service.js';
import {runSandbox, type SandboxFiles} from './sandbox.js';
import {parseSkillDocument, skillByName, skillPath} from './skills.js';
import type {ToolsStorage} from './ports.js';

/** Enabled skills for the frozen system-prompt catalog (conversation.ts builds the section). */
export async function listSkillsForCatalog(ctx: FeatureContext): Promise<{name: string; description: string}[]> {
  return (await ctx.store.list(ctx.userId, 'skill'))
    .filter(r => !r.deleted && r.value.enabled !== false)
    .map(r => SkillSchema.parse(r.value))
    .map(s => ({name: s.name, description: s.description}));
}

const LoadSkill = z.object({name: z.string().min(1).max(64)});
const ReadSkillFile = z.object({skill: z.string().min(1).max(64), path: z.string().min(1), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50_000).default(20_000)});
const text = (value: string, isError = false) => ({content: [{type: 'text', text: value}], isError});

/** Port of AgentSkills `load_skill` / `read_skill_file` (scripts stay dropped in v1). */
export function skillTools(ctx: FeatureContext, storage?: ToolsStorage): FeatureTool[] {
  return [
    ...skillAuthoringTools(ctx, storage),
    {
      name: 'load_skill',
      description: "Load a skill's full instructions. Call this before starting a task that matches one of the skills listed in the system prompt, then follow the instructions it returns.",
      inputSchema: {type: 'object', properties: {name: {type: 'string', description: 'Skill name exactly as listed, e.g. "pdf-processing"'}}, required: ['name']},
      source: {type: 'builtin'},
      traits: ['readOnly', 'idempotent'],
      async execute(args) {
        const {name} = LoadSkill.parse(args);
        try {
          const skill = await skillByName(ctx, name);
          return text(parseSkillDocument(skill.document).body);
        } catch (error) {
          return text(`Couldn't load ${name}: ${error instanceof Error ? error.message : 'unknown error'}`, true);
        }
      },
    },
    {
      name: 'read_skill_file',
      description: 'Read a text file bundled with a skill (paths as listed by load_skill). Long files are returned in pages: pass offset to continue.',
      inputSchema: {
        type: 'object',
        properties: {
          skill: {type: 'string', description: 'Skill name'},
          path: {type: 'string', description: 'File path relative to the skill folder, e.g. "reference/forms.md"'},
          offset: {type: 'integer', description: 'Character offset to start at (default 0)'},
          limit: {type: 'integer', description: 'Characters to read (default 20000, max 50000)'},
        },
        required: ['skill', 'path'],
      },
      source: {type: 'builtin'},
      traits: ['readOnly', 'idempotent'],
      async execute(args) {
        const input = ReadSkillFile.parse(args);
        try {
          skillPath(input.path);
          const skill = await skillByName(ctx, input.skill);
          const bundle = await toolsState(ctx, storage).get(ctx.userId, 'skill', skill.id);
          const files = bundle?.files;
          const body = input.path === 'SKILL.md' ? skill.document : files && typeof files === 'object' && !Array.isArray(files) ? files[input.path] : undefined;
          if (typeof body !== 'string') return text(`${input.skill} has no file ${input.path}.`, true);
          if (Buffer.byteLength(body) > MAX_SKILL_FILE_BYTES) return text('Skill file exceeds 500 KB.', true);
          const page = body.slice(input.offset, input.offset + input.limit);
          const next = input.offset + input.limit < body.length ? `\n\n[Continues: pass offset ${input.offset + input.limit}]` : '';
          return text(page + next);
        } catch (error) {
          return text(error instanceof ApiError || error instanceof Error ? error.message : 'Could not read skill file', true);
        }
      },
    },
  ];
}

/** `run_javascript`: QuickJS sandbox with the run's visible attachments as read-only files. */
export function javascriptTool(ctx: FeatureContext, input: {attachmentIds: string[]; storage?: ToolsStorage; hostToolNames: string[]}): FeatureTool {
  const files: SandboxFiles = {
    async list() {
      const names: string[] = [];
      for (const id of input.attachmentIds) {
        const row = await ctx.store.get(ctx.userId, 'attachment', id);
        if (row && !row.deleted && row.value.hiddenFromCode !== true) names.push(String(row.value.name));
      }
      return names;
    },
    async read(name) {
      for (const id of input.attachmentIds) {
        const row = await ctx.store.get(ctx.userId, 'attachment', id);
        if (!row || row.deleted || row.value.hiddenFromCode === true || row.value.name !== name) continue;
        if (!input.storage) throw new Error('Attachment storage is not configured');
        return (await input.storage.read(ctx.userId, String(row.value.storageId))).bytes;
      }
      throw new Error(`No attached file named ${name}`);
    },
  };
  return {
    name: 'run_javascript',
    description: 'Run JavaScript in an isolated QuickJS sandbox (no Node, no DOM). Use it for calculations, data processing and parsing attached files (fs.list(), fs.readText(name), fs.readBytes(name)). fetch(url, init) reaches the network (GET/HEAD only in plan mode); kv.get/kv.set persist small JSON values for this chat; tools.<name>(args) or callTool(name, args) calls other tools. Return a value or console.log the result. Default timeout 5 s, max 30 s; 16 MB memory.',
    inputSchema: {type: 'object', properties: {code: {type: 'string', description: 'JavaScript source; top-level await is allowed'}, timeout_ms: {type: 'integer', description: 'Time limit in milliseconds (default 5000, max 30000)'}}, required: ['code']},
    source: {type: 'builtin'},
    traits: ['sandboxed', 'openWorld'],
    async execute(args: JsonValue, execution) {
      const output = await runSandbox(args, ctx, execution, files, input.hostToolNames, toolsState(ctx, input.storage));
      return text(JSON.stringify(output), !!output.error);
    },
  };
}
