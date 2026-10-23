// Shared phone filters must keep their external focus ring inside the scrollport.
// Exercise actual Tab scrolling in both directions, including forced colors.
const assert = require('node:assert/strict');
const checkChipFocus = async (page, chips, screenshot) => {
  const buttons = chips.locator('button'), count = await buttons.count();
  assert.ok(count > 1, 'Agent-filter fixture needs multiple chips');
  try {
    for (const forcedColors of ['none', 'active']) {
      await page.emulateMedia({ forcedColors });
      await buttons.first().focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      const check = async index => {
        const state = await buttons.nth(index).evaluate(button => {
          const row = button.closest('.tc-sk-agent-chips'), port = row.getBoundingClientRect(), box = button.getBoundingClientRect(), style = getComputedStyle(button);
          const ring = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
          return { label: button.textContent, focused: button === document.activeElement && button.matches(':focus-visible'), outline: style.outlineStyle, width: parseFloat(style.outlineWidth), height: box.height,
            inPort: box.left - ring >= port.left + row.clientLeft - 0.5 && box.right + ring <= port.left + row.clientLeft + row.clientWidth + 0.5 && box.top - ring >= port.top + row.clientTop - 0.5 && box.bottom + ring <= port.top + row.clientTop + row.clientHeight + 0.5,
            inPage: box.left - ring >= 0 && box.right + ring <= innerWidth && document.documentElement.scrollWidth <= innerWidth + 1 };
        });
        assert.ok(state.focused && state.outline !== 'none' && state.width >= 2, 'Visible keyboard focus: ' + JSON.stringify(state));
        assert.ok(state.inPort && state.inPage, 'Complete chip focus ring stays visible: ' + JSON.stringify(state));
        assert.ok(state.height >= 44, 'Phone filter keeps a 44px touch target');
      };
      for (let index = 0; index < count; index++) {
        if (index) await page.keyboard.press('Tab');
        await check(index);
        if (forcedColors === 'none' && (index === 0 || index === count - 1)) await screenshot('agent-filter-' + (index ? 'last' : 'first'));
      }
      for (let index = count - 2; index >= 0; index--) { await page.keyboard.press('Shift+Tab'); await check(index); }
    }
  } finally { await page.emulateMedia({ forcedColors: 'none' }); }
};
module.exports = { checkChipFocus };
