'use strict';
const { isWebURL } = require('./model.cjs');
// OAuth libraries first open an empty, native opener-linked window and then
// navigate it to the provider. Only that initial blank document is permitted.
function popupTarget(url) { return url === '' || url === 'about:blank' ? 'about:blank' : isWebURL(url) ? url : null; }
module.exports = { popupTarget };
