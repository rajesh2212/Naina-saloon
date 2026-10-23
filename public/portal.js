/* ============================================================================
   Staff portal behaviour. Progressive only: every page here is complete
   without it. Two jobs — show each salon timestamp next to the reader's own
   clock so nobody misreads an appointment, and stop a double submit from
   firing two status changes at the diary.
   ========================================================================== */
'use strict';

(function () {
  var doc = document;
  var root = doc.documentElement;

  var salonZone = root.getAttribute('data-salon-zone') || '';
  var readerZone = '';
  try {
    readerZone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch (error) {
    readerZone = '';
  }

  var differs = Boolean(readerZone) && Boolean(salonZone) && readerZone !== salonZone;

  // The footer legend names the device's own zone, whether or not it agrees
  // with the studio's. The server cannot read it, so JS fills it in; with JS
  // off the sentence in views/portal/partials/foot.ejs stays honest.
  var legend = doc.getElementById('local-zone');
  if (legend && readerZone) legend.textContent = readerZone;

  // ------------------------------------------------ salon time + your time
  // The server already wrote the salon clock inside the element; this appends
  // the same instant read on the browser's clock, labelled, and only when the
  // two clocks genuinely disagree.
  if (differs) {
    var local = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    Array.prototype.forEach.call(doc.querySelectorAll('time[data-iso]'), function (el) {
      var iso = el.getAttribute('data-iso');
      if (!iso) return;
      var when = new Date(iso);
      if (isNaN(when.getTime())) return;
      var note = doc.createElement('span');
      note.className = 'p-local';
      note.textContent = local.format(when);
      el.appendChild(note);
    });
  }

  // ------------------------------------------------------- double-submit guard
  Array.prototype.forEach.call(doc.querySelectorAll('form[data-guarded]'), function (form) {
    var clicked = null;

    form.addEventListener('click', function (event) {
      var button = event.target && event.target.closest ? event.target.closest('button[type="submit"]') : null;
      if (button && form.contains(button)) clicked = button;
    });

    form.addEventListener('submit', function (event) {
      if (form.getAttribute('data-busy') === '1') {
        // Second attempt while the first is still in flight — the slot hold or
        // the status write may already be committed by now.
        event.preventDefault();
        return;
      }
      form.setAttribute('data-busy', '1');
      form.classList.add('is-busy');
      if (clicked) clicked.setAttribute('data-busy-active', 'true');
      Array.prototype.forEach.call(form.querySelectorAll('button[type="submit"]'), function (button) {
        if (button !== clicked) button.setAttribute('aria-disabled', 'true');
      });
      // A page restored from the back button must not stay locked.
      window.setTimeout(function () {
        form.removeAttribute('data-busy');
        form.classList.remove('is-busy');
        Array.prototype.forEach.call(form.querySelectorAll('button'), function (button) {
          button.removeAttribute('aria-disabled');
          button.removeAttribute('data-busy-active');
        });
      }, 12000);
    });
  });

  // Keep a submitted filter readable: the search box is a GET form, so its
  // values are already in the address bar. Nothing to do beyond the guard.
})();
