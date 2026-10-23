/* Progressive enhancement only — every flow below also works without JS. */
(function () {
  'use strict';

  var doc = document;

  // ---------------------------------------------------------------- header nav
  var toggle = doc.querySelector('[data-nav-toggle]');
  var nav = doc.querySelector('[data-nav]');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.getAttribute('data-open') === 'true';
      nav.setAttribute('data-open', open ? 'false' : 'true');
      toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
    });
    doc.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && nav.getAttribute('data-open') === 'true') {
        nav.setAttribute('data-open', 'false');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.focus();
      }
    });
  }

  // ------------------------------------------------------- CAPTCHA refresh
  doc.querySelectorAll('[data-captcha-refresh]').forEach(function (button) {
    button.addEventListener('click', function () {
      var img = doc.querySelector('[data-captcha-image]');
      if (!img) return;
      var base = img.getAttribute('src').split('?')[0];
      img.setAttribute('src', base + '?r=' + Date.now());
      var input = button.closest('.captcha-box').querySelector('input[name="captcha_answer"]');
      if (input) {
        input.value = '';
        input.focus();
      }
      var status = button.closest('.captcha-box').querySelector('[data-captcha-status]');
      if (status) status.textContent = 'New image loaded. Type the characters you see.';
    });
  });

  // ------------------------------------------------- booking: slot loading
  var slotsForm = doc.querySelector('[data-slots-form]');
  if (slotsForm) {
    var endpoint = slotsForm.getAttribute('data-slots-endpoint');
    var listRegion = slotsForm.querySelector('[data-slot-list]');
    var live = slotsForm.querySelector('[data-slot-status]');
    var loading = slotsForm.querySelector('[data-slot-loading]');
    var confirmButton = slotsForm.querySelector('[data-confirm-button]');
    var csrfToken = slotsForm.querySelector('input[name="_csrf"]');

    function setStatus(message) {
      if (live) live.textContent = message;
    }

    function pad(value) {
      return String(value).length === 2 ? String(value) : '0' + String(value);
    }

    function to12(value) {
      var parts = value.split(':');
      var hour = Number(parts[0]);
      var minute = parts[1];
      var suffix = hour >= 12 ? 'pm' : 'am';
      var display = hour % 12 === 0 ? 12 : hour % 12;
      return display + ':' + minute + ' ' + suffix;
    }

    function renderSlots(slots, duration) {
      listRegion.textContent = '';
      slots.forEach(function (slot) {
        var label = doc.createElement('label');
        label.className = 'slot';

        var input = doc.createElement('input');
        input.type = 'radio';
        input.name = 'slot_id';
        input.value = String(slot.id);
        input.setAttribute('data-start', slot.startTime);

        var box = doc.createElement('span');
        var strong = doc.createElement('strong');
        strong.textContent = slot.label || to12(slot.startTime);
        box.appendChild(strong);

        if (duration) {
          var small = doc.createElement('small');
          var endMinutes = slot.startTime.split(':');
          var total = Number(endMinutes[0]) * 60 + Number(endMinutes[1]) + Number(duration);
          small.textContent = 'till ' + to12(pad(Math.floor(total / 60)) + ':' + pad(total % 60));
          box.appendChild(small);
        }

        label.appendChild(input);
        label.appendChild(box);
        listRegion.appendChild(label);
      });
    }

    function load(date, announce) {
      if (loading) loading.setAttribute('data-visible', 'true');
      if (announce) setStatus('Looking up free times…');

      var url = endpoint + '?date=' + encodeURIComponent(date);
      if (csrfToken) url += '&_csrf=' + encodeURIComponent(csrfToken.value);

      fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (response) {
          return response.json().then(function (body) {
            return { ok: response.ok, body: body };
          });
        })
        .then(function (result) {
          if (loading) loading.setAttribute('data-visible', 'false');
          if (!result.ok || !result.body || result.body.ok === false) {
            listRegion.textContent = '';
            setStatus(result.body && result.body.error ? result.body.error : 'Could not load times. Please use the links above.');
            return;
          }
          renderSlots(result.body.slots || [], result.body.durationMinutes);
          if (!result.body.slots || !result.body.slots.length) {
            setStatus(result.body.notice || 'No free times left on that date.');
            return;
          }
          setStatus(
            (result.body.slots.length === 1 ? '1 free time' : result.body.slots.length + ' free times') +
              ' on ' + (result.body.dayLabel || '') + '. Choose one.',
          );
        })
        .catch(function () {
          if (loading) loading.setAttribute('data-visible', 'false');
          setStatus('Could not reach the studio. Check your connection, or refresh the page.');
        });
    }

    // Intercept the date strip so switching days feels instant.
    doc.querySelectorAll('[data-date-link]').forEach(function (link) {
      link.addEventListener('click', function (event) {
        var href = link.getAttribute('href') || '';
        var match = href.match(/[?&]date=(\d{4}-\d{2}-\d{2})/);
        if (!match) return;
        event.preventDefault();
        doc.querySelectorAll('[data-date-link]').forEach(function (other) {
          other.setAttribute('aria-current', other === link ? 'true' : 'false');
        });
        var hidden = slotsForm.querySelector('input[name="date"]');
        if (hidden) hidden.value = match[1];
        var heading = doc.querySelector('[data-selected-day]');
        if (heading) heading.textContent = link.getAttribute('data-day-label') || match[1];
        load(match[1], true);
      });
    });

    // A native date input is offered for far-ahead dates.
    var jump = slotsForm.querySelector('[data-date-jump]');
    if (jump) {
      jump.addEventListener('change', function () {
        if (/^\d{4}-\d{2}-\d{2}$/.test(jump.value)) load(jump.value, true);
      });
    }

    if (confirmButton) {
      var sync = function () {
        var chosen = slotsForm.querySelector('input[name="slot_id"]:checked');
        confirmButton.disabled = !chosen;
        if (chosen) {
          var hint = confirmButton.querySelector('[data-selection-hint]');
          if (hint) hint.textContent = '— ' + (chosen.getAttribute('data-start') || '') + ' chosen';
        }
      };
      slotsForm.addEventListener('change', sync);
      sync();
    }
  }

  // ------------------------------------------------ double-submit protection
  doc.querySelectorAll('form[data-once]').forEach(function (form) {
    form.addEventListener('submit', function () {
      var button = form.querySelector('button[type="submit"]');
      if (!button) return;
      window.setTimeout(function () {
        button.setAttribute('aria-disabled', 'true');
        button.classList.add('btn');
        button.dataset.sending = 'true';
      }, 0);
    });
  });
})();
