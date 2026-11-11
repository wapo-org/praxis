/** User-facing recovery instructions; transport/provider diagnostics do not belong in the chat column. */
export function runErrorCopy(error:unknown):string {
 const text=error instanceof Error?error.message:typeof error==='string'?error:'';
 if(/\/v1\/runs/.test(text))return 'This chat or its model is no longer available. Refresh the page and start a new chat.';
 if(/try again|choose .*model|refresh|sign in|allow sharing/i.test(text))return text;
 if(/api key|credential|unauthoriz|authentication/i.test(text))return "The model provider couldn't sign in. Check its API key in Settings, then try again.";
 if(/429|rate.?limit|overload|busy/i.test(text))return 'The service is busy. Wait a moment and try again.';
 if(/network|fetch|timeout|timed out|connection/i.test(text))return "The service couldn't be reached. Check your connection and try again.";
 return "The response was interrupted. Try again, or choose another model in Settings.";
}
