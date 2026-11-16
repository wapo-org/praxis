import {test,expect} from '@playwright/test';
const expected='Hello **world** 👩🏽‍💻 é 中文 שלום.';
test.beforeEach(async({page})=>{
  await page.goto('/lab/stream');
  const signIn=page.getByRole('button',{name:'Continue as local dev user'});
  await signIn.waitFor(); await signIn.click();
  await page.getByRole('heading',{name:'Stream simulator'}).waitFor();
});
for(const chunk of ['char','token','word','sentence','2kb','whole']) for(const speed of ['2tps','40tps','1500tps','burstStall','jitter','instant']) {
  test(`${chunk} at ${speed}: exact, monotonic text`,async({page})=>{
    test.setTimeout(60000);
    await page.getByLabel('sample',{exact:true}).selectOption('short');
    await page.getByLabel('reasoningShape',{exact:true}).selectOption('none');
    await page.getByLabel('chunkSize',{exact:true}).selectOption(chunk);
    await page.getByLabel('speed',{exact:true}).selectOption(speed);
    await page.getByLabel('splitMode',{exact:true}).selectOption('none');
    await page.evaluate(() => {
      const state = window as unknown as {reveals: string[]};
      state.reveals = [];
      new MutationObserver(() => {
        const text = Array.from(document.querySelectorAll('[data-revealed]'))
          .map(node => node.getAttribute('data-revealed')).join('');
        if (text) state.reveals.push(text);
      }).observe(document.body, {subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ['data-revealed']});
    });
    await page.getByRole('button',{name:'Start stream',exact:true}).click();
    await expect(page.getByTestId('stream-status')).toHaveText('completed');
    await expect(page.getByTestId('stream-final')).toHaveText(expected);
    await expect(page.getByTestId('agent-message-view')).toHaveAttribute('data-revealed',expected);
    const values = await page.evaluate(() => (window as unknown as {reveals: string[]}).reveals);
    // WP-L3: no typewriter. Text is shown in the frame it arrives in (with a fade), so a whole arrival is one step.
    if(chunk==='whole'&&speed==='instant')expect(values.at(-1)).toBe(expected);
    for(let i=1;i<values.length;i++) expect(values[i]!.startsWith(values[i-1]!), JSON.stringify([values[i-1],values[i]])).toBe(true);
  });
}
for(const shape of ['titles','summary','raw','redacted','none']) test(`reasoning ${shape} expands and finishes`,async({page})=>{
  await page.getByLabel('sample',{exact:true}).selectOption('short');
  await page.getByLabel('reasoningShape',{exact:true}).selectOption(shape);
  await page.getByLabel('speed',{exact:true}).selectOption('1500tps');
  await page.getByRole('button',{name:'Start stream',exact:true}).click();
  await expect(page.getByTestId('stream-status')).toHaveText('completed');
  if(shape==='none') {await expect(page.getByTestId('reasoning-view')).toHaveCount(0);return;}
  const view=page.getByTestId('reasoning-view');await expect(view).toHaveAttribute('data-live','false');
  const button=view.getByRole('button');await expect(button).toHaveAttribute('aria-expanded','false');await button.click();await expect(button).toHaveAttribute('aria-expanded','true');
  // Never a zero duration: under a second it reasoned briefly (WP-J2).
  await expect(button).toContainText(/Reasoned (for \d|briefly)/);
  await expect(button).not.toContainText(/for 0s/);
  expect(await view.innerText()).not.toContain('**');
});

test('split-surrogate torture, empty deltas and late reasoning survive reload',async({page})=>{
  await page.getByLabel('sample',{exact:true}).selectOption('short');
  await page.getByLabel('reasoningShape',{exact:true}).selectOption('none');
  await page.getByLabel('speed',{exact:true}).selectOption('2tps');
  await page.getByLabel('splitMode',{exact:true}).selectOption('torture');
  await page.getByLabel('edgeCase',{exact:true}).selectOption('emptyDeltas');
  await page.getByRole('button',{name:'Start stream',exact:true}).click();
  await expect(page.getByTestId('agent-message-view')).toBeVisible();
  await page.reload();await page.getByRole('heading',{name:'Stream simulator'}).waitFor();
  await expect(page.getByTestId('stream-status')).toHaveText('completed');
  await expect(page.getByTestId('stream-final')).toHaveText(expected);
});
test('user stop terminates the local stream',async({page})=>{
  await page.getByLabel('speed',{exact:true}).selectOption('2tps');
  await page.getByRole('button',{name:'Start stream',exact:true}).click();
  await page.getByTestId('reasoning-view').waitFor();
  await page.getByRole('button',{name:'Stop stream',exact:true}).click();
  await expect(page.getByTestId('stream-status')).toHaveText('cancelled');
  await expect(page.getByTestId('reasoning-view')).toHaveAttribute('data-live','false');
});

for (const edge of ['emptyDeltas','duplicateFinal','reasoningAfterText','midStreamError']) test(`edge ${edge}`,async({page})=>{
  await page.getByLabel('sample',{exact:true}).selectOption('short');
  await page.getByLabel('speed',{exact:true}).selectOption('instant');
  await page.getByLabel('reasoningShape',{exact:true}).selectOption('summary');
  await page.getByLabel('edgeCase',{exact:true}).selectOption(edge);
  await page.getByRole('button',{name:'Start stream',exact:true}).click();
  await expect(page.getByTestId('stream-status')).toHaveText(edge==='midStreamError'?'failed':'completed');
  if(edge!=='midStreamError') await expect(page.getByTestId('stream-final')).toHaveText(expected);
});
test('headed frame interval report at 1500 tokens/s', async ({page}, info) => {
  test.skip(process.env.PW_H2_PERF !== '1', 'Opt-in headed frame report: PW_H2_PERF=1 --headed');
  await page.getByLabel('sample', {exact: true}).selectOption('torture');
  await page.getByLabel('reasoningShape', {exact: true}).selectOption('none');
  await page.getByLabel('speed', {exact: true}).selectOption('1500tps');
  await page.getByLabel('splitMode', {exact: true}).selectOption('torture');
  await page.evaluate(() => {
    const state = window as unknown as {h2Frames: number[]; h2Recording: boolean};
    state.h2Frames = [];
    state.h2Recording = true;
    let last = performance.now();
    function tick(now: number) {
      if (!state.h2Recording) return;
      state.h2Frames.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
  await page.getByRole('button', {name: 'Start stream', exact: true}).click();
  await expect(page.getByTestId('stream-status')).toHaveText('completed');
  const frames = await page.evaluate(() => {
    const state = window as unknown as {h2Frames: number[]; h2Recording: boolean};
    state.h2Recording = false;
    return state.h2Frames;
  });
  frames.sort((a, b) => a - b);
  await info.attach('frame-intervals.json', {body: JSON.stringify({
    p95FrameMs: frames[Math.floor(frames.length * 0.95)] ?? null, samples: frames.length,
  }), contentType: 'application/json'});
  await expect(page.getByTestId('agent-message-view')).toHaveAttribute(
    'data-revealed', await page.getByTestId('stream-final').innerText());
});

test('ten-second burst stall resumes without dropping text',async({page})=>{
  await page.getByLabel('sample',{exact:true}).selectOption('short');
  await page.getByLabel('reasoningShape',{exact:true}).selectOption('none');
  await page.getByLabel('speed',{exact:true}).selectOption('burstStall');
  await page.getByLabel('stallDuration',{exact:true}).selectOption('10s');
  await page.getByRole('button',{name:'Start stream',exact:true}).click();
  await expect(page.getByTestId('stream-status')).toHaveText('completed',{timeout:15000});
  await expect(page.getByTestId('stream-final')).toHaveText(expected);
});
test('tool iterations retain one work group and reasoning order after reload',async({page})=>{
  const id=await page.evaluate(async()=>{
    // @ts-expect-error Vite source import.
    const {apiClient}=await import('/src/lib/api.ts');
    const chat=await apiClient.createChat({title:'H2 reasoning between tools'});
    await apiClient.startRun({chatId:chat.id,text:'Interleaved reasoning',script:'reasoningInterleaved'});return chat.id;
  });
  await page.goto(`/c/${id}`);await page.getByTestId('turn-copy-button').last().waitFor();
  for(const reload of [false,true]){
    if(reload){await page.reload();await page.getByTestId('turn-copy-button').last().waitFor();}
    await expect(page.getByTestId('agent-activity-view')).toHaveCount(1);
    await page.getByTestId('agent-activity-toggle').click();
    await expect(page.locator('[data-testid^=tool-step-header-]')).toHaveCount(1);
    // WP-K2: reasoning lives inside "Worked for", as rows interleaved with the calls; nothing outside it.
    await expect(page.getByTestId('reasoning-row')).toHaveCount(2);
    await expect(page.getByTestId('reasoning-view')).toHaveCount(0);
    const order=await page.getByTestId('agent-activity-view').evaluate(el=>Array.from(el.querySelectorAll('[data-testid="reasoning-row"],[data-testid^="tool-step-header-"]')).map(node=>(node as HTMLElement).dataset.testid));
    expect(order).toEqual(['reasoning-row',expect.stringMatching(/^tool-step-header-/),'reasoning-row']);
    if(process.env.H2_CAPTURE_DIR){for(const button of await page.getByTestId('reasoning-row').getByRole('button').all())await button.click();await page.screenshot({path:`${process.env.H2_CAPTURE_DIR}/reasoning-tool-order-${test.info().project.name}-${reload?'restored':'initial'}.png`,animations:'disabled'});}
  }
});
