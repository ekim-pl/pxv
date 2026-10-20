/** Measure fixed-size cards in Chromium, splitting only text and repeating each entry's identity. */
export const cardPagination = String.raw`
(() => {
  const source = document.querySelector('#source');
  const template = document.querySelector('#card');
  let page, content;
  const cards = [];
  function newCard() {
    page = template.content.firstElementChild.cloneNode(true);
    document.body.append(page);
    content = page.querySelector('main');
    cards.push(page);
    if (content.clientHeight < 30) throw new Error('Identity exceeds card capacity');
  }
  function fits() {
    return content.scrollHeight <= content.clientHeight && content.scrollWidth <= content.clientWidth;
  }
  function place(entry) {
    entry.classList.remove('same-identity', 'same-state');
    const previous = content.lastElementChild;
    if (previous && previous.querySelector('h2').textContent === entry.querySelector('h2').textContent) {
      entry.classList.add('same-identity');
      const before = previous.querySelector('.state');
      const after = entry.querySelector('.state');
      if (before && after && before.textContent === after.textContent) entry.classList.add('same-state');
    }
    content.append(entry);
  }
  function split(entry) {
    const pre = entry.querySelector('pre');
    if (!pre) throw new Error('Entry exceeds card capacity');
    const chars = Array.from(pre.textContent);
    let offset = 0;
    while (offset < chars.length) {
      const part = entry.cloneNode(true);
      const value = part.querySelector('pre');
      place(part);
      let low = 0, high = chars.length - offset;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        value.textContent = chars.slice(offset, offset + mid).join('');
        if (fits()) low = mid; else high = mid - 1;
      }
      if (!low) throw new Error('Entry heading exceeds card capacity');
      value.textContent = chars.slice(offset, offset + low).join('');
      offset += low;
      if (offset < chars.length) newCard();
    }
  }
  try {
    newCard();
    for (const entry of [...source.children]) {
      place(entry);
      if (fits()) continue;
      entry.remove();
      if (content.children.length) newCard();
      place(entry);
      if (fits()) continue;
      entry.remove();
      split(entry);
    }
    source.remove();
    template.remove();
    cards.forEach((card, index) => {
      card.querySelector('footer').textContent = (index + 1) + ' / ' + cards.length;
    });
    document.title = 'PXV_LAYOUT_OK';
  } catch {
    document.title = 'PXV_LAYOUT_ERROR';
  }
})();`;
