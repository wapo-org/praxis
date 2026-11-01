if (!process.env.BASE) throw new Error('Set BASE to the running web origin; set API for direct API checks (otherwise BASE proxy is used).');
export const BASE = new URL(process.env.BASE).href.replace(/\/$/, '');
export const API = new URL(process.env.API ?? BASE).href.replace(/\/$/, '');
