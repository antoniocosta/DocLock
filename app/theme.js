// Applies the chosen theme (light or dark) before the page draws, so it
// doesn't flash the other one. Auto, the default, follows the device.
// app.js handles the button; store.js keeps the choice.
// It also refuses to show the page inside another site's frame, so no one
// can lay a fake page over it and steer your clicks.
(function () {
  try {
    var t = JSON.parse(localStorage.getItem('doclock.theme.v1'));
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch (e) { /* auto */ }
  var framed;
  try { framed = top !== self && top.location.origin !== location.origin; } catch (e) { framed = true; } // another site's frame can't be read
  if (framed) document.documentElement.hidden = true;
})();
