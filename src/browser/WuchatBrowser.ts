import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chromium, Browser, BrowserContext, CDPSession, Page } from 'playwright-core';

const CHROME_PATHS = [
	process.env.CHROME_PATH,
	'/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/brave-browser', '/usr/bin/microsoft-edge',
	'/usr/bin/chromium', '/usr/bin/chromium-browser',
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].filter((value): value is string => !!value);

/** A local, visible Chrome window shared by Wuchat's tools and chat attachments. */
export class WuchatBrowser implements vscode.Disposable {
	private browser?: Browser;
	private browserPromise?: Promise<Browser>;
	private context?: BrowserContext;
	private page?: Page;
	private pagePromise?: Promise<Page>;
	private pickAbort?: AbortController;
	private disposed = false;
	private onElement?: (description: string, screenshot: Uint8Array, url: string) => Promise<void>;
	private onScreenshot?: (data: Uint8Array, url: string) => Promise<void>;
	private onPickStateChange?: (picking: boolean) => void;

	get isPicking(): boolean { return !!this.pickAbort; }

	setContextHandlers(
		onElement: (description: string, screenshot: Uint8Array, url: string) => Promise<void>,
		onScreenshot: (data: Uint8Array, url: string) => Promise<void>,
		onPickStateChange?: (picking: boolean) => void
	): void {
		this.onElement = onElement;
		this.onScreenshot = onScreenshot;
		this.onPickStateChange = onPickStateChange;
	}

	private async ensureBrowser(): Promise<Browser> {
		if (this.disposed) throw new Error('Wuchat Browser has been closed.');
		if (this.browser?.isConnected()) return this.browser;
		if (!this.browserPromise) {
			const executablePath = CHROME_PATHS.find(existsSync);
			if (!executablePath) throw new Error('Chrome or Chromium is required for Wuchat Browser. Set CHROME_PATH to its executable.');
			this.browserPromise = chromium.launch({ executablePath, headless: false, args: ['--no-first-run', '--disable-infobars'] })
				.then(browser => {
					if (this.disposed) { void browser.close(); throw new Error('Wuchat Browser has been closed.'); }
					this.browser = browser;
					this.context = undefined;
					this.page = undefined;
					return browser;
				})
				.finally(() => { this.browserPromise = undefined; });
		}
		return this.browserPromise;
	}

	private async ensurePage(): Promise<Page> {
		const browser = await this.ensureBrowser();
		if (this.page && !this.page.isClosed()) return this.page;
		if (!this.pagePromise) {
			this.pagePromise = (async () => {
				if (!this.context || this.context.browser() !== browser) {
					this.context = await browser.newContext({ viewport: null, ignoreHTTPSErrors: true });
					this.context.on('page', page => {
						this.page = page;
						page.on('close', () => {
							if (this.page === page) this.page = this.context?.pages().filter(candidate => !candidate.isClosed()).at(-1);
						});
					});
				}
				this.page = await this.context.newPage();
				return this.page;
			})().finally(() => { this.pagePromise = undefined; });
		}
		return this.pagePromise;
	}

	private normalizeUrl(rawUrl: string): string {
		const value = (rawUrl ?? '').trim();
		if (!value || value === 'about:blank') return 'about:blank';
		if (/^(https?|file):\/\//i.test(value)) return value;
		if (/^[\w.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(value)) return `https://${value}`;
		if (value.startsWith('localhost') || /^\d{1,3}(\.\d{1,3}){3}/.test(value)) return `http://${value}`;
		return `https://duckduckgo.com/?q=${encodeURIComponent(value)}`;
	}

	async open(): Promise<void> {
		const page = await this.ensurePage();
		await page.bringToFront();
	}

	async pickBrowserElement(): Promise<void> {
		if (this.pickAbort) {
			this.cancelPickBrowserElement();
			return;
		}
		const controller = new AbortController();
		this.pickAbort = controller;
		this.onPickStateChange?.(true);
		try {
			while (!controller.signal.aborted && await this.pickNextElement(controller)) { /* keep picking until canceled */ }
		} finally {
			this.pickAbort = undefined;
			this.onPickStateChange?.(false);
		}
	}

	private async pickNextElement(controller: AbortController): Promise<boolean> {
		const sessions = new Map<Page, CDPSession>();
		const registering = new Set<Promise<void>>();
		let context: BrowserContext | undefined;
		let onPage: ((page: Page) => void) | undefined;
		try {
			await this.ensurePage();
			if (controller.signal.aborted) return false;
			context = this.context!;
			const selected = await new Promise<{ page: Page; cdp: CDPSession; backendNodeId: number } | undefined>((resolve, reject) => {
				let finished = false;
				const finish = (selection?: { page: Page; cdp: CDPSession; backendNodeId: number }, error?: Error) => {
					if (finished) return;
					finished = true;
					controller.signal.removeEventListener('abort', cancel);
					if (onPage) context?.off('page', onPage);
					if (error) reject(error); else resolve(selection);
				};
				const cancel = () => finish();
				const register = (page: Page): void => {
					if (finished || page.isClosed() || sessions.has(page)) return;
					const task = (async () => {
						const cdp = await context!.newCDPSession(page);
						sessions.set(page, cdp);
						if (finished) return;
						cdp.on('Overlay.inspectNodeRequested', ({ backendNodeId }: { backendNodeId: number }) => finish({ page, cdp, backendNodeId }));
						cdp.on('Overlay.inspectModeCanceled', cancel);
						await cdp.send('DOM.enable');
						await cdp.send('Overlay.enable');
						if (finished) return;
						await cdp.send('Overlay.setInspectMode', {
							mode: 'searchForNode',
							highlightConfig: { showInfo: true, contentColor: { r: 66, g: 133, b: 244, a: 0.25 }, borderColor: { r: 66, g: 133, b: 244, a: 1 } }
						});
					})();
					registering.add(task);
					void task.catch(error => { if (!finished && !page.isClosed()) finish(undefined, error instanceof Error ? error : new Error(String(error))); }).finally(() => registering.delete(task));
				};
				onPage = register;
				context!.on('page', register);
				controller.signal.addEventListener('abort', cancel, { once: true });
				for (const page of context!.pages()) register(page);
				if (controller.signal.aborted) cancel();
			});
			if (!selected || controller.signal.aborted) return false;
			const { page, cdp, backendNodeId } = selected;
			this.page = page;
			await cdp.send('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} });
			const { object } = await cdp.send('DOM.resolveNode', { backendNodeId });
			if (!object.objectId) throw new Error('Selected element is no longer available.');
			const { result, exceptionDetails } = await cdp.send('Runtime.callFunctionOn', {
				objectId: object.objectId,
				functionDeclaration: `function() {
					const rect = this.getBoundingClientRect();
					const style = getComputedStyle(this);
					return {
						selector: this.tagName.toLowerCase() + (this.id ? '#' + this.id : ''),
						text: (this.textContent || '').trim().slice(0, 3000),
						html: this.outerHTML.slice(0, 12000),
						bounds: [rect.x, rect.y, rect.width, rect.height].map(Math.round),
						styles: ['color', 'backgroundColor', 'display', 'font'].map(key => key + '=' + style[key]).join('; ')
					};
				}`, returnByValue: true
			});
			if (exceptionDetails || !result.value?.html) throw new Error('Selected element is no longer available.');
			const value = result.value;
			const marker = randomUUID();
			const attribute = 'data-wuchat-selected';
			const { result: previous } = await cdp.send('Runtime.callFunctionOn', {
				objectId: object.objectId,
				functionDeclaration: 'function(attribute, marker) { const original = this.getAttribute(attribute); this.setAttribute(attribute, marker); return original; }',
				arguments: [{ value: attribute }, { value: marker }], returnByValue: true
			});
			try {
				const screenshot = await page.locator(`[${attribute}="${marker}"]`).screenshot({ type: 'png' });
				if (!controller.signal.aborted) await this.onElement?.(`Page: ${page.url()}\nSelector: ${value.selector}\nBounds: ${value.bounds.join(', ')}\nText: ${value.text}\nHTML: ${value.html}\nStyles: ${value.styles}`, screenshot, page.url());
			} finally {
				await cdp.send('Runtime.callFunctionOn', {
					objectId: object.objectId,
					functionDeclaration: 'function(attribute, marker, original) { if (this.getAttribute(attribute) === marker) { if (original === null) this.removeAttribute(attribute); else this.setAttribute(attribute, original); } }',
					arguments: [{ value: attribute }, { value: marker }, { value: previous.value ?? null }]
				}).catch(() => {});
			}
		} finally {
			if (context && onPage) context.off('page', onPage);
			await Promise.allSettled([...registering]);
			for (const cdp of sessions.values()) {
				await cdp.send('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} }).catch(() => {});
				await cdp.detach().catch(() => {});
			}
		}
		return !controller.signal.aborted;
	}

	cancelPickBrowserElement(): void {
		this.pickAbort?.abort();
	}

	async captureScreenshot(): Promise<void> {
		const page = await this.ensurePage();
		const data = await page.screenshot({ type: 'png' });
		await this.onScreenshot?.(data, page.url());
	}

	async navigate(rawUrl: string): Promise<string> {
		const page = await this.ensurePage();
		const url = this.normalizeUrl(rawUrl);
		try {
			await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
		} catch (error) {
			return `Failed to open ${url}: ${error instanceof Error ? error.message : String(error)}`;
		}
		return `Opened ${page.url()}`;
	}

	async runAction(rawInput: string): Promise<string> {
		let input: { action?: string; url?: string; selector?: string; text?: string; key?: string };
		try { input = JSON.parse(rawInput); } catch { throw new Error('Wuchat Browser expects JSON with action and optional url, selector, text or key.'); }
		const page = await this.ensurePage();
		switch (input.action) {
			case 'navigate': return this.navigate(input.url || 'about:blank');
			case 'click': if (!input.selector) throw new Error('selector is required'); await page.locator(input.selector).first().click({ timeout: 15_000 }); return `Clicked ${input.selector}`;
			case 'fill': if (!input.selector) throw new Error('selector is required'); await page.locator(input.selector).first().fill(input.text || '', { timeout: 15_000 }); return `Filled ${input.selector}`;
			case 'press': await page.keyboard.press(input.key || 'Enter'); return `Pressed ${input.key || 'Enter'}`;
			case 'snapshot': return (await page.locator('body').ariaSnapshot()).slice(0, 20_000);
			case 'screenshot': await this.captureScreenshot(); return `Screenshot of ${page.url()} added to Wuchat chat`;
			case 'inspect': if (!input.selector) throw new Error('selector is required'); return page.locator(input.selector).first().evaluate(element => element.outerHTML.slice(0, 12000));
			default: throw new Error('Actions: navigate, click, fill, press, snapshot, screenshot, inspect.');
		}
	}

	dispose(): void {
		this.disposed = true;
		this.cancelPickBrowserElement();
		void this.browser?.close();
	}
}