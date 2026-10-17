Browser screenshots for the setup row layout regression.

The former Provider updates row (structure from b60e9cf, removed in 8823eff) is rendered as a regression fixture using the real console styles. Before uses console.css from 8823eff; after uses the three guarded plain-row selectors from this fix. The fixture, content, viewport and theme are identical within each pair. Viewports: desktop 1440×900; mobile 390×844. PNGs are cropped to the Updates section. These are fixture captures, not screenshots of the current Agents page.
