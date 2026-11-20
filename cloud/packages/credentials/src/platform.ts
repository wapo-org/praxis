/** Platform-paid key pools: production reads them and live checks inspect them, so both use these names. */
export const GROQ_POOL = {name: 'GROQ_API_KEY', service: 'groq'} as const;
/** Modal is platform-paid (PRA-19); each slot is one Modal account, and a placed owner never leaves it (PRA-99). */
export const MODAL_POOL = {names: ['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET'], service: 'modal'} as const;
