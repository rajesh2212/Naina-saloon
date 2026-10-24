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

  // ------------------------------------------------------- pop-ups: one sheet
  // Every pop-up on this site is a real <dialog>, and they all behave the same
  // way: the sheet floats centred over a scrim, the page behind stops scrolling
  // and then goes back to exactly where it was, and the × in its corner closes
  // that one sheet. The × and the outside click are handled by delegation, so a
  // dialog filled in later — the account panel arrives by fetch — needs nothing
  // re-bound. A click outside is refused while an editor in the sheet holds
  // typing the customer has not saved; Escape always works, since closing is
  // never the destructive direction there.
  var page = doc.documentElement;
  // Which sheets the visitor is looking at right now, in the order they opened.
  // A counter would be wrong here: opening a second sheet over the first must
  // keep the page locked, and a stale close event arriving late must not unlock
  // a sheet that is still on screen.
  var openSheets = [];
  var closeHooks = [];

  function sheetHasEdits(sheet) {
    var fields = sheet.querySelectorAll('input, textarea, select');
    for (var i = 0; i < fields.length; i += 1) {
      var field = fields[i];
      if (field.type === 'checkbox' || field.type === 'radio') {
        if (field.checked !== field.defaultChecked) return true;
      } else if (field.value !== field.defaultValue) {
        return true;
      }
    }
    return false;
  }

  function syncPageLock() {
    if (openSheets.length) {
      if (page.hasAttribute('data-popup-open')) return;
      var gap = Math.max(0, window.innerWidth - page.clientWidth);
      page.style.setProperty('--popup-gap', gap + 'px');
      page.setAttribute('data-popup-open', '');
      return;
    }
    page.removeAttribute('data-popup-open');
    page.style.removeProperty('--popup-gap');
  }

  function releaseSheet(sheet) {
    var at = openSheets.indexOf(sheet);
    if (at > -1) openSheets.splice(at, 1);
    syncPageLock();
    closeHooks.forEach(function (hook) {
      if (hook.sheet === sheet) hook.fn();
    });
  }

  /** A sheet can hand its own cleanup to this controller without knowing its rules. */
  function onSheetClose(sheet, fn) {
    closeHooks.push({ sheet: sheet, fn: fn });
  }

  function openSheet(sheet) {
    var wasScroll = window.scrollY;
    sheet.setAttribute('data-modal', 'true');
    // showModal() refuses a sheet that is already on screen.
    if (sheet.open) sheet.close();
    if (openSheets.indexOf(sheet) === -1) openSheets.push(sheet);
    syncPageLock();
    sheet.showModal();
    // The lock can shorten the page by the scrollbar it hid, so put the visitor
    // back on the row they were reading before the sheet covers it.
    window.scrollTo(0, wasScroll);
    // The sheet itself, not the first control in it: opening a panel should not
    // leave the × one Enter key away from closing it again.
    sheet.focus({ preventScroll: true });
  }

  function closeSheet(sheet) {
    if (sheet.open) sheet.close();
    sheet.removeAttribute('data-modal');
    releaseSheet(sheet);
  }

  doc.querySelectorAll('dialog').forEach(function (sheet) {
    // The browser's own directions — Escape above all — close a sheet without
    // asking this script. Only a sheet that really left the screen may release
    // the lock, so a close event still in the queue from an earlier re-open
    // cannot unlock a sheet that is open again.
    sheet.addEventListener('close', function () {
      if (!sheet.open) releaseSheet(sheet);
    });
    // Escape is the browser's own close direction. Releasing the page here too
    // means the lock never outlives the sheet, whatever the engine does with the
    // close event — and closing is never the destructive direction, so an editor
    // full of unsaved typing still gets away.
    sheet.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeSheet(sheet);
    });
    // A click that lands on the dialog element itself came from the scrim.
    sheet.addEventListener('click', function (event) {
      if (event.target !== sheet || sheetHasEdits(sheet)) return;
      closeSheet(sheet);
    });
  });

  doc.addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('[data-popup-close]') : null;
    if (!button) return;
    var sheet = button.closest('dialog');
    if (sheet) closeSheet(sheet);
  });

  // ---------------------------------------------------- account: the pop panel
  // The header icon is a real link to /account; this only intercepts the click.
  // Everything the panel shows is fetched from /account/panel, so the details,
  // the two booking lists and the tick all come from the same reads the account
  // pages do — and the customer's own session decides whose they are.
  var accountPanel = doc.querySelector('[data-account-panel]');
  var accountTrigger = doc.querySelector('[data-account-trigger]');
  if (accountPanel && accountTrigger) {
    var accountBody = accountPanel.querySelector('[data-account-panel-body]');

    function syncHeaderAvatar(root) {
      var avatar = root.querySelector('[data-account-avatar]');
      if (!avatar) return;
      var path = avatar.getAttribute('data-photo-path') || '';
      var image = accountTrigger.querySelector('.header-account__img');
      var icon = accountTrigger.querySelector('.header-account__icon');
      if (path) {
        if (!image) {
          image = doc.createElement('img');
          image.className = 'header-account__img';
          image.alt = '';
          image.width = 32;
          image.height = 32;
          accountTrigger.insertBefore(image, accountTrigger.firstChild);
        }
        if (image.getAttribute('src') !== path) image.setAttribute('src', path);
        image.hidden = false;
        if (icon) icon.hidden = true;
        return;
      }
      if (image) image.remove();
      if (icon) icon.hidden = false;
    }

    function showPanel(markup) {
      accountBody.innerHTML = markup;
      accountBody.scrollTop = 0;
      syncHeaderAvatar(accountPanel);
    }

    function fetchPanel(url) {
      return fetch(url, { headers: { accept: 'text/html' }, credentials: 'same-origin' })
        .then(function (response) {
          // A sign-in wall or an expired session answers with a whole page.
          // Send the browser to it instead of pasting it into the sheet.
          if (response.redirected || response.headers.get('x-naina-panel') !== '1') {
            window.location.assign(url);
            return '';
          }
          return response.text();
        })
        .then(function (markup) {
          if (markup) showPanel(markup);
        })
        .catch(function () {
          accountBody.textContent = '';
          var note = doc.createElement('p');
          note.className = 'alert alert--error';
          note.setAttribute('role', 'alert');
          note.textContent = 'Could not reach the studio. Please open My bookings instead.';
          accountBody.appendChild(note);
        });
    }

    function selectTab(which) {
      accountPanel.querySelectorAll('[data-panel-tab]').forEach(function (button) {
        var on = button.getAttribute('data-panel-tab') === which;
        button.setAttribute('aria-selected', on ? 'true' : 'false');
        button.tabIndex = on ? 0 : -1;
      });
      accountPanel.querySelectorAll('[data-panel-list]').forEach(function (list) {
        list.hidden = list.getAttribute('data-panel-list') !== which;
      });
    }

    accountTrigger.setAttribute('aria-haspopup', 'dialog');
    accountTrigger.setAttribute('aria-controls', accountPanel.id);
    accountTrigger.addEventListener('click', function (event) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      openSheet(accountPanel);
      accountTrigger.setAttribute('aria-expanded', 'true');
      fetchPanel('/account/panel');
    });
    onSheetClose(accountPanel, function () {
      accountTrigger.setAttribute('aria-expanded', 'false');
      // Drop the details and the booking list off the page once the sheet is shut.
      accountBody.textContent = '';
    });

    accountPanel.addEventListener('click', function (event) {
      var tab = event.target.closest('[data-panel-tab]');
      if (tab) {
        event.preventDefault();
        selectTab(tab.getAttribute('data-panel-tab'));
        tab.focus();
        return;
      }
      var edit = event.target.closest('[data-panel-edit]');
      if (edit) {
        event.preventDefault();
        fetchPanel('/account/panel?edit=' + encodeURIComponent(edit.getAttribute('data-panel-edit')));
        return;
      }
      if (event.target.closest('[data-panel-cancel]')) {
        event.preventDefault();
        fetchPanel('/account/panel');
      }
    });

    // Tablist arrows, because role="tablist" promises them.
    accountPanel.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      var tab = event.target.closest('[data-panel-tab]');
      if (!tab) return;
      var tabs = Array.prototype.slice.call(accountPanel.querySelectorAll('[data-panel-tab]'));
      var next = tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      event.preventDefault();
      selectTab(next.getAttribute('data-panel-tab'));
      next.focus();
    });

    // The editor saves through the same /account/profile route the page uses, with
    // one header to say which screen asked. The server answers with this sheet
    // already rebuilt, so a save shows the new details without a page change.
    accountPanel.addEventListener('submit', function (event) {
      var form = event.target.closest('[data-panel-form]');
      if (!form) return;
      event.preventDefault();
      var button = form.querySelector('button[type="submit"]');
      if (button) button.disabled = true;
      fetch(form.action, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          accept: 'text/html',
          'content-type': 'application/x-www-form-urlencoded',
          'x-naina-panel': '1',
        },
        body: new URLSearchParams(new FormData(form)).toString(),
      })
        .then(function (response) {
          if (response.redirected || response.headers.get('x-naina-panel') !== '1') {
            window.location.assign(form.action);
            return '';
          }
          return response.text();
        })
        .then(function (markup) {
          if (!markup) return;
          showPanel(markup);
          var back = accountPanel.querySelector('[data-panel-tab]');
          if (back) back.focus();
        })
        .catch(function () {
          if (button) button.disabled = false;
          var note = doc.createElement('p');
          note.className = 'alert alert--error';
          note.setAttribute('role', 'alert');
          note.textContent = 'That save did not go through. Nothing was changed — please try again.';
          accountBody.insertBefore(note, accountBody.firstChild);
        });
    });
  }

  // ---------------------------------------------------- auth: show the password
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
  // Bound by delegation because two editors can be on screen at once — the one on
  // /account/profile and the one inside the account pop-up, whose markup arrives
  // after this script has run. Each picker only touches its own container.
  var SIDE = 256;

  function photoState(box) {
    return box.querySelector('[data-photo-state]');
  }

  function photoSay(box, message) {
    var state = photoState(box);
    if (!state) return;
    state.hidden = false;
    state.textContent = message;
  }

  function photoClear(box) {
    var data = box.querySelector('[data-photo-data]');
    if (data) data.value = '';
    var preview = box.querySelector('[data-photo-preview]');
    if (preview) {
      preview.removeAttribute('src');
      preview.hidden = true;
    }
  }

  function photoPaint(box, source, width, height) {
    var canvas = doc.createElement('canvas');
    canvas.width = SIDE;
    canvas.height = SIDE;
    var ctx = canvas.getContext('2d');
    if (!ctx) {
      photoSay(box, 'This browser cannot resize the picture, so it was not attached. Your other details still save.');
      return;
    }
    var side = Math.min(width, height);
    ctx.fillStyle = '#fdf8f4';
    ctx.fillRect(0, 0, SIDE, SIDE);
    ctx.drawImage(source, (width - side) / 2, (height - side) / 2, side, side, 0, 0, SIDE, SIDE);
    var url = canvas.toDataURL('image/jpeg', 0.82);
    var data = box.querySelector('[data-photo-data]');
    if (data) data.value = url;
    var preview = box.querySelector('[data-photo-preview]');
    if (preview) {
      preview.src = url;
      preview.hidden = false;
    }
    photoSay(box, 'Squared and shrunk to ' + SIDE + ' px — it saves with the rest of your details.');
  }

  doc.addEventListener('change', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var box = target.closest('[data-photo-picker]');
    if (!box) return;

    if (target.matches('[data-photo-remove]')) {
      if (!target.checked) return;
      photoClear(box);
      var removeInput = box.querySelector('[data-photo-input]');
      if (removeInput && removeInput.files && removeInput.files.length) removeInput.value = '';
      photoSay(box, 'The saved photo will be removed when you save.');
      return;
    }

    if (!target.matches('[data-photo-input]')) return;
    var file = target.files && target.files[0];
    photoClear(box);
    if (!file) return;
    if (!/image\/(jpeg|png|webp)/.test(file.type)) {
      photoSay(box, 'That file is not a JPEG, PNG or WebP picture. Choose another one.');
      target.value = '';
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      photoSay(box, 'That picture is over 12 MB. Choose a smaller one.');
      target.value = '';
      return;
    }
    photoSay(box, 'Reading the picture…');
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () { photoPaint(box, img, img.naturalWidth || img.width, img.naturalHeight || img.height); };
      img.onerror = function () { photoSay(box, 'That picture could not be opened. Try another file.'); };
      img.src = reader.result;
    };
    reader.onerror = function () { photoSay(box, 'That picture could not be read. Try another file.'); };
    reader.readAsDataURL(file);
  });

  // -------------------------------------------- booking: the step panel
  // The page renders its second half inside a <dialog open>, which without JS is
  // just a card further down the page. Here it is closed and re-opened modally so
  // it sits centred over a scrim, and the top-left control walks back through the
  // steps — details to times, times to the service and date behind it. Nothing is
  // re-fetched on the way back, so every choice the visitor made stays where it was.
  var panel = doc.querySelector('[data-step-panel]');
  var panelBack = doc.querySelector('[data-panel-back]');
  var detailsStep = doc.querySelector('[data-panel-step="details"]');
  var panelWhere = doc.querySelector('[data-panel-where]');
  var pickedNote = doc.querySelector('[data-panel-picked]');
  var pickedNoteText = pickedNote ? pickedNote.textContent.trim() : '';
  var backLabel = doc.querySelector('[data-panel-back-label]');
  var atTimes = true;
  // A re-rendered form that already has errors must keep its details open; the
  // server says so with data-shown. Otherwise step four waits for a time.
  var keepDetailsOpen = !detailsStep || detailsStep.getAttribute('data-shown') === 'true';

  function setPanelWhere(text) {
    if (!panelWhere) return;
    if (text) panelWhere.textContent = text;
  }

  function showDetails(show) {
    atTimes = !show;
    if (!detailsStep) return;
    detailsStep.hidden = !show;
    if (backLabel) backLabel.textContent = show ? 'Choose another time' : 'Back';
  }

  function revealFor(chosen) {
    if (keepDetailsOpen) return;
    showDetails(Boolean(chosen));
    var time = chosen ? (chosen.getAttribute('data-start') || '') : '';
    setPanelWhere(chosen ? 'Time chosen: ' + time : null);
    if (pickedNote) pickedNote.textContent = chosen
      ? time + ' is held for you as a request — the studio calls to confirm it.'
      : pickedNoteText;
  }

  if (panel) {
    // The shared sheet controller above owns the modal switch, the scrim click
    // and the page lock; this only decides which step is showing.
    openSheet(panel);
    if (panelWhere) panelWhere.setAttribute('data-day', panelWhere.textContent);
    // Nothing is pre-selected when the sheet opens, so the only reason to show
    // step four straight away is a form the server sent back with errors.
    showDetails(keepDetailsOpen);
  }

  if (panelBack && panel) {
    panelBack.addEventListener('click', function (event) {
      event.preventDefault();
      if (!atTimes) {
        showDetails(false);
        setPanelWhere(panelWhere ? panelWhere.getAttribute('data-day') : null);
        var times = doc.querySelector('#step-3');
        if (times) times.scrollIntoView({ block: 'center' });
        var firstRadio = slotsForm ? slotsForm.querySelector('input[name="slot_id"]') : null;
        if (firstRadio) firstRadio.focus();
        return;
      }
      // Back to step one: the panel closes and the service and date the form
      // already holds stay filled in behind it.
      closeSheet(panel);
      var serviceSelect = doc.querySelector('#service');
      if (serviceSelect) {
        serviceSelect.focus();
        var step1 = doc.querySelector('#step-1');
        if (step1) step1.scrollIntoView({ block: 'center' });
      }
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
          var count = (result.body.slots || []).length;
          var freeCount = doc.querySelector('[data-free-count]');
          if (freeCount) freeCount.textContent = String(count);
          revealFor(null);
          if (!result.body.slots || !result.body.slots.length) {
            setStatus(result.body.notice || 'No free times left on that date.');
            return;
          }
          setStatus(
            (count === 1 ? '1 free time' : count + ' free times') +
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
        revealFor(chosen);
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
  // The submit button is really disabled once a request is on its way, so a
  // second click or a held Enter key cannot send the same slot twice. The server
  // still has the final say: a duplicate hits the one-active-booking-per-slot
  // index and comes back as a conflict, not as a second booking.
  doc.querySelectorAll('form[data-once]').forEach(function (form) {
    var sending = false;
    form.addEventListener('submit', function (event) {
      if (sending) {
        event.preventDefault();
        return;
      }
      sending = true;
      var button = form.querySelector('button[type="submit"]');
      if (!button) return;
      window.setTimeout(function () {
        button.disabled = true;
        button.setAttribute('aria-disabled', 'true');
        button.dataset.sending = 'true';
      }, 0);
    });
    // A form the server sent back with errors is still this same page: let the
    // visitor fix it and try again rather than leaving it locked.
    window.addEventListener('pageshow', function (event) {
      if (event.persisted) {
        sending = false;
        var retry = form.querySelector('button[type="submit"]');
        if (retry) {
          retry.disabled = false;
          retry.removeAttribute('aria-disabled');
          delete retry.dataset.sending;
        }
      }
    });
  });
})();
