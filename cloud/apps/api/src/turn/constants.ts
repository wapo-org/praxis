export const TURN_HMAC_ALGORITHM = 'sha256';
export const TURN_SIGNATURE_HEX_CHARACTERS = 64;
export const TURN_RECEIPT_KIND = 'turnCallerReceipt';
export const TURN_METHOD = 'POST';
export const TURN_ALLOW_HEADER = 'Allow';
export const TURN_ERROR = {
 tooLarge: {code: 'turn_too_large', message: 'Turn request exceeds the byte limit'},
 unauthorized: {code: 'turn_unauthorized', message: 'Invalid turn caller credential'},
 unavailable: {code: 'turn_unavailable', message: 'Turn worker is not configured'},
 method: {code: 'turn_method_not_allowed', message: 'Use POST for turn requests'},
 invalid: {code: 'turn_invalid_request', message: 'Invalid turn request'},
 upstream: {code: 'turn_upstream_error', message: 'Turn could not be completed'},
 conflict: {code: 'turn_index_conflict', message: 'Turn index was already committed or moved on'},
} as const;
