import path from 'path';
import fs from 'fs';
import kleur from 'kleur';
import htmlparser2 from 'htmlparser2';
import * as core from '@actions/core';

/**
 * Contains all link checking logic.
 */
class BrokenLinkChecker {
	constructor ({
		baseUrl,
		buildOutputDir,
		pageSourceDir,
		annotateOutput = false
	}) {
		this.baseUrl = baseUrl;
		this.buildOutputDir = buildOutputDir;
		this.pageSourceDir = pageSourceDir;
		this.annotateOutput = annotateOutput;

		this.prefixPage = kleur.gray(`[${kleur.red().bold('404')}]`);
		this.prefixHash = kleur.gray(`[${kleur.yellow().bold(' # ')}]`);
	}

	/**
	 * Checks all pages referenced by the sitemap for broken links
	 * and outputs the result to the console.
	 */
	run () {
		// Get the pathnames of all content pages from the sitemap contained in the build output
		const pagePathnames = this.getPagePathnamesFromSitemap();

		// Parse all pages referenced by the sitemap and build an index of their contents
		const pages = this.parsePages(pagePathnames);

		// Find all broken links
		const brokenLinks = this.findBrokenLinks(pages);

		// Output the result
		this.outputResult(brokenLinks);
	}

	/**
	 * Reads the `sitemap.xml` from the build output and extracts all unique pathnames.
	 */
	getPagePathnamesFromSitemap () {
		const sitemapFilePath = path.join(this.buildOutputDir, 'sitemap.xml');
		const sitemap = fs.readFileSync(sitemapFilePath, 'utf8');
		const sitemapRegex = new RegExp(`<loc>${this.baseUrl}(/.*?)</loc>`, 'ig');
		const uniquePagePaths = [...new Set(Array.from(
			sitemap.matchAll(sitemapRegex),
			m => m[1]
		))];

		return uniquePagePaths;
	}

	/**
	 * Parses multiple HTML pages based on their pathnames and builds an index of their contents.
	 */
	parsePages (pathnames) {
		const pages = {};
		pathnames.forEach(pathname => {
			pages[pathname] = this.parsePage(pathname);
		});

		return pages;
	}

	/**
	 * Parses an HTML page based on its pathname and builds an index of its contents.
	 */
	parsePage (pathname) {
		const href = this.pathnameToHref(pathname);
		const htmlFilePath = this.pathnameToHtmlFilePath(pathname);

		if (!fs.existsSync(htmlFilePath)) {
			throw new Error('Failed to find HTML file referenced by sitemap: ' + htmlFilePath);
		}

		const dom = htmlparser2.parseDocument(fs.readFileSync(htmlFilePath));
		const anchors = htmlparser2.DomUtils
			.getElementsByTagName('a', dom, true);
		
		// Build a list of unique link hrefs on the page
		const linkHrefs = [...new Set(anchors
			.map(el => el.attribs.href)
		)];

		// Build a list of hashes provided by the page (mostly used as scroll targets)
		const anchorNames = anchors
			.map(el => el.attribs.name)
			.filter(name => name !== undefined);
		const ids = htmlparser2.DomUtils
			.getElements({ id: id => id !== undefined }, dom, true)
			.map(el => el.attribs.id);
		const hashes = [...anchorNames, ...ids]
			.map(name => `#${name}`);

		// Attempt to determine the source file the current page was likely generated from
		var sourceFilePath = this.pathnameToSourceFilePath(pathname);
		console.log(`Converted pathname="${pathname}" to sourceFilePath="${sourceFilePath}"`);

		return {
			pathname,
			href,
			htmlFilePath,
			sourceFilePath,
			linkHrefs,
			hashes,
		};
	}

	/**
	 * Goes through all pre-parsed and indexed pages, checks their links,
	 * and returns an array containing all broken links (if any).
	 */
	findBrokenLinks (pages) {
		var brokenLinks = [];

		Object.values(pages).forEach(page => {
			// Go through all link hrefs on the page
			page.linkHrefs.forEach(linkHref => {
				const url = new URL(linkHref, page.href);

				// Ignore external URLs
				if (!url.href.startsWith(this.baseUrl))
					return;
				
				var linkPathname = url.pathname;
				if (!linkPathname.endsWith('/')) {
					linkPathname += '/';
				}
				const linkedPage = pages[linkPathname];
				const isMissingPage = !linkedPage;

				const decodedHash = url.hash && decodeURIComponent(url.hash);
				const isMissingHash = (
					!isMissingPage &&
					(decodedHash && !linkedPage.hashes.includes(decodedHash))
				);

				if (isMissingPage || isMissingHash) {
					brokenLinks.push({
						page,
						href: url.href,
						isMissingPage,
						isMissingHash,
					});
				}
			});
		});
		
		return brokenLinks;
	}

	/**
	 * Outputs the result of the broken link check to the console.
	 */
	outputResult (brokenLinks) {
		const totalBroken = brokenLinks.length;

		if (totalBroken > 0) {
			const brokenHashCount = brokenLinks.filter(brokenLink => brokenLink.isMissingHash).length;
			const brokenPageCount = totalBroken - brokenHashCount;

			var lastPage;
			brokenLinks.forEach(brokenLink => {
				if (lastPage !== brokenLink.page) {
					console.log(`\n${brokenLink.page.pathname}`);
					lastPage = brokenLink.page;
				}
				this.outputBrokenLink(brokenLink);
			});
			console.log();

			const summary = [
				`*** Found ${totalBroken} broken ${totalBroken === 1 ? 'link' : 'links'} in total:`,
				`  ${this.prefixPage} ${brokenPageCount} broken page ${brokenPageCount === 1 ? 'link' : 'links'}`,
				`  ${this.prefixHash} ${brokenHashCount} broken fragment ${brokenHashCount === 1 ? 'link' : 'links'}`,
			];
			console.log(kleur.white().bold(summary.join('\n')));

			// Set a non-zero exit code to indicate that broken links were found
			process.exitCode = 1;
		} else {
			console.log(kleur.green().bold('*** Found no broken links. Great job!'));
		}		
		console.log();
	}

	outputBrokenLink (brokenLink) {
		console.log(`  ${brokenLink.isMissingHash ? this.prefixHash : this.prefixPage} ${brokenLink.href}`);
		if (this.annotateOutput) {
			const absoluteSourceFilePath = brokenLink.page.sourceFilePath &&
				path.resolve(brokenLink.page.sourceFilePath);
			core.error(brokenLink.href, {
				title: `${brokenLink.isMissingHash ? 'Broken fragment' : '404 link'} in ${brokenLink.page.pathname}`,
				file: absoluteSourceFilePath,
			});
			// this.outputWorkflowCommand({
			// 	type: 'error',
			// 	message: brokenLink.href,
			// 	params: {
			// 		file: absoluteSourceFilePath,
			// 		title: `${brokenLink.isMissingHash ? 'Broken fragment' : '404 link'} in ${brokenLink.page.pathname}`,
			// 	},
			// });
		}
	}

	outputWorkflowCommand ({ type, message, params = {} }) {
		const serializedParams = Object.keys(params).map(key => {
			return `${key}=${params[key]}`;
		}).join(',');
		console.log(`outputting type=${type} with params=${serializedParams ? ` ${serializedParams}` : ''} and message=${message}`);
		console.log(`::${type}${serializedParams ? ` ${serializedParams}` : ''}::${message}`);
	}

	pathnameToHref (pathname) {
		const url = new URL(pathname, this.baseUrl);
		return url.href;
	}

	pathnameToHtmlFilePath (pathname) {
		return path.join(this.buildOutputDir, pathname, 'index.html');
	}

	/**
	 * Attempts to determine the source file path used to generate the given route `pathname`.
	 * 
	 * Given a route pathname of `/path/to/route/`, the source file will be searched
	 * in the following locations below `pageSourceDir`:
	 * - `path/to/route.md`
	 * - `path/to/route/index.md`
	 * 
	 * @returns The source file path, or `undefined` if it cannot be found.
	 */
	pathnameToSourceFilePath (pathname) {
		const possiblePaths = [
			path.join(this.pageSourceDir, pathname, '.') + '.md',
			path.join(this.pageSourceDir, pathname, 'index.md'),
		];
		
		return possiblePaths.find(possiblePath => fs.existsSync(possiblePath));
	}
}

// Use our class to check for broken links
const brokenLinkChecker = new BrokenLinkChecker({
	baseUrl: 'https://docs.astro.build',
	buildOutputDir: './dist',
	pageSourceDir: './src/pages',
	annotateOutput: process.env.GITHUB_ACTION !== undefined,
});

brokenLinkChecker.run();
