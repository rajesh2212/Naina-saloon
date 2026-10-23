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

  // ---------------------------------------------------- password reveal
  // The input keeps its real `type="password"` without JS; this only ever changes
  // the one field the button points at, and says which state it is in.
  doc.querySelectorAll('[data-reveal]').forEach(function (button) {
    var input = doc.getElementById(button.getAttribute('data-reveal'));
    if (!input) return;
    var label = button.querySelector('[data-reveal-label]');
    button.addEventListener('click', function () {
      var showing = input.type === 'password';
      input.type = showing ? 'text' : 'password';
      button.setAttribute('aria-pressed', showing ? 'true' : 'false');
      if (label) label.textContent = showing ? 'Hide' : 'Show';
    });
  });

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

  // ------------------------------------------- profile photo: crop, shrink, send
  // The picture is squared and resized here so a phone camera never leaves the
  // device at full size. The server re-checks every byte regardless.
  var photoInput = doc.querySelector('[data-photo-input]');
  if (photoInput) {
    var photoData = doc.querySelector('[data-photo-data]');
    var photoPreview = doc.querySelector('[data-photo-preview]');
    var photoState = doc.querySelector('[data-photo-state]');
    var photoRemove = doc.querySelector('[data-photo-remove]');
    var SIDE = 256;

    var say = function (message) {
      if (photoState) {
        photoState.hidden = false;
        photoState.textContent = message;
      }
    };

    var clearPick = function () {
      photoData.value = '';
      if (photoPreview) {
        photoPreview.removeAttribute('src');
        photoPreview.hidden = true;
      }
    };

    var paint = function (source, width, height) {
      var canvas = doc.createElement('canvas');
      canvas.width = SIDE;
      canvas.height = SIDE;
      var ctx = canvas.getContext('2d');
      if (!ctx) {
        say('This browser cannot resize the picture, so it was not attached. Your other details still save.');
        return;
      }
      var side = Math.min(width, height);
      ctx.fillStyle = '#fdf8f4';
      ctx.fillRect(0, 0, SIDE, SIDE);
      ctx.drawImage(source, (width - side) / 2, (height - side) / 2, side, side, 0, 0, SIDE, SIDE);
      var url = canvas.toDataURL('image/jpeg', 0.82);
      photoData.value = url;
      if (photoPreview) {
        photoPreview.src = url;
        photoPreview.hidden = false;
      }
      say('Squared and shrunk to ' + SIDE + ' px — it saves with the rest of your details.');
    };

    if (photoRemove) {
      photoRemove.addEventListener('change', function () {
        if (!photoRemove.checked) return;
        clearPick();
        if (photoInput.files && photoInput.files.length) photoInput.value = '';
        say('The saved photo will be removed when you save.');
      });
    }

    photoInput.addEventListener('change', function () {
      var file = photoInput.files && photoInput.files[0];
      clearPick();
      if (!file) return;
      if (!/image\/(jpeg|png|webp)/.test(file.type)) {
        say('That file is not a JPEG, PNG or WebP picture. Choose another one.');
        photoInput.value = '';
        return;
      }
      if (file.size > 12 * 1024 * 1024) {
        say('That picture is over 12 MB. Choose a smaller one.');
        photoInput.value = '';
        return;
      }
      say('Reading the picture…');
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () { paint(img, img.naturalWidth || img.width, img.naturalHeight || img.height); };
        img.onerror = function () { say('That picture could not be opened. Try another file.'); };
        img.src = reader.result;
      };
      reader.onerror = function () { say('That picture could not be read. Try another file.'); };
      reader.readAsDataURL(file);
    });
  }

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

  // ------------------------------------------------------ hero pointer drift
  // The wordmark and the portrait lean a few pixels apart as the pointer moves, which
  // is the only thing on the page that reacts to it. The numbers land in `--par-x` and
  // `--par-y`; the amplitudes that turn them into pixels live in the stylesheet, next
  // to the measurements they have to stay inside. A fine pointer only, and never when
  // the visitor has asked for less movement — the CSS entrance is already disabled there.
  var hero = doc.querySelector('.hero');
  var calm = window.matchMedia('(prefers-reduced-motion: reduce)');
  var precise = window.matchMedia('(hover: hover) and (pointer: fine)');
  if (hero && !calm.matches && precise.matches) {
    var driftX = 0;
    var driftY = 0;
    var frame = 0;
    var paint = function () {
      frame = 0;
      hero.style.setProperty('--par-x', driftX.toFixed(3));
      hero.style.setProperty('--par-y', driftY.toFixed(3));
    };
    window.addEventListener('pointermove', function (event) {
      driftX = (event.clientX / window.innerWidth - 0.5) * 2;
      driftY = (event.clientY / window.innerHeight - 0.5) * 2;
      if (!frame) frame = window.requestAnimationFrame(paint);
    }, { passive: true });
    doc.addEventListener('mouseleave', function () {
      driftX = 0;
      driftY = 0;
      if (!frame) frame = window.requestAnimationFrame(paint);
    }, { passive: true });
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
