import { WuchatTool } from '../common/types';
import { WuchatBrowser } from './WuchatBrowser';

export function createBrowserTool(browser: WuchatBrowser): WuchatTool {
	return {
		id: 'wuchat.browser',
		name: 'Wuchat Browser',
		description: 'Controls the dedicated Wuchat Playwright browser. Can open pages, inspect accessibility and HTML, click, fill, press keys and capture screenshots. Requires approval for every action unless the user enabled automatic approval.',
		requiresApproval: true,
		inputSchema: 'JSON: {"action":"navigate|snapshot|click|fill|press|inspect|screenshot", "url":"...", "selector":"...", "text":"...", "key":"..."}. Supply fields relevant to the action.',
		async invoke(rawInput) { return browser.runAction(rawInput); }
	};
}
