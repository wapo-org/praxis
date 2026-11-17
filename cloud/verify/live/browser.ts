import {defineSuite} from '@praxis/verify';
import {checkBrowserImage} from '../../packages/sandbox-tools/src/modal/browser-check.js';

const LIVE_OPT_IN = 'PRAXIS_MODAL_BROWSER_LIVE';
export default defineSuite({
  id: 'browser', issue: 'PRA-20', title: 'Modal Chromium and praxis-browser layer',
  steps: [{
    id: 'modal-browser', kind: 'auto',
    checklist: 'One pinned image build and sandbox boot; fixture sign-in, screenshot proof, image filesystem size and cold start; terminate.',
    needs: {config: [LIVE_OPT_IN]},
    async run(context) {
      if (context.config(LIVE_OPT_IN) !== '1') throw new Error('Set PRAXIS_MODAL_BROWSER_LIVE=1 to authorize one image build and one boot.');
      const {screenshotBytes, ...result} = await checkBrowserImage();
      context.attach('browser-screenshot.png', screenshotBytes);
      context.attach('browser-image.json', JSON.stringify(result, null, 2));
      return {status: 'pass', summary: `Fixture and screenshot verified; filesystem ${result.filesystemBytes} bytes; cold start ${result.coldStartMs} ms; terminated.`};
    },
  }],
});
