import { marked } from 'marked';

/** @param {string} text @returns {string[]} */
export function documentLinks(text) {
  /** @type {string[]} */
  const links = [];
  marked.walkTokens(marked.lexer(text), (token) => {
    if ((token.type === 'link' || token.type === 'image') && typeof token.href === 'string')
      links.push(token.href);
  });
  return links;
}
/** @param {string} href */
export function placeholderLink(href) {
  return href.trim() === '' || href.trim() === '#';
}
