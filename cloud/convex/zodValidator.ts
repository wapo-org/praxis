import {v, type GenericValidator, type Validator} from 'convex/values';
import {z} from 'zod';

/** Handler arguments stay unknown until the protocol schema parses them, so refinements are never skipped. */
export type ProtocolValidator = Validator<unknown, 'required', string>;
/** Derives the Convex transport validator from a protocol schema. */
export function convexValidator(schema: z.ZodType): ProtocolValidator {
  return transport(schema) as ProtocolValidator;
}
function transport(schema: z.ZodType): GenericValidator {
  if (schema instanceof z.ZodOptional) return v.optional(transport(schema.unwrap() as z.ZodType));
  if (schema instanceof z.ZodString) return v.string();
  if (schema instanceof z.ZodNumber) return v.number();
  if (schema instanceof z.ZodBoolean) return v.boolean();
  if (schema instanceof z.ZodEnum) {
    const [first, second, ...rest] = schema.options.map(option => v.literal(String(option)));
    if (!first) throw new Error('Empty enum has no Convex validator');
    return second ? v.union(first, second, ...rest) : first;
  }
  if (schema instanceof z.ZodObject) {
    return v.object(Object.fromEntries(Object.entries(schema.shape).map(([key, field]) => [key, transport(field as z.ZodType)])));
  }
  throw new Error('Unsupported protocol schema for a Convex validator');
}
