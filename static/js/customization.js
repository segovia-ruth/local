/* =====================================================================
   LeafTutor customization
   Theme, text size, background, and accessibility

   IMPORTANT:
   - Load in <head>, NOT deferred.
   - Remove the old customization block from common.js.
   - Uses the existing LeafTutor localStorage keys.
   - Accessibility options use data-pref checkboxes.
   ===================================================================== */

(function () {
    'use strict';

    var root = document.documentElement;

    var THEMES = ['light', 'dark', 'system'];
    var SIZES = ['small', 'medium', 'large', 'xlarge'];
    var BGS = ['default', 'cream', 'mint', 'sky', 'neutral'];

    /*
     * Preference name -> CSS class on <html>
     */
    var FLAGS = {
        highContrast: 'high-contrast',
        reduceMotion: 'reduce-motion',
        underlineLinks: 'underline-links',
        lineSpacing: 'line-spacing',
        readableFont: 'readable-font',
        focusRing: 'focus-ring'
    };

    /*
     * Older controls that may still exist in the project.
     */
    var LEGACY_IDS = {
        themeSelect: 'theme',
        highContrastToggle: 'highContrast',
        reduceMotionToggle: 'reduceMotion',
        underlineLinksToggle: 'underlineLinks'
    };

    /* ================================================================
       STORAGE
       ================================================================ */

    function key(name) {
        return 'leafTutor' +
            name.charAt(0).toUpperCase() +
            name.slice(1);
    }

    function read(name) {
        try {
            return localStorage.getItem(key(name));
        } catch (e) {
            return null;
        }
    }

    function write(name, value) {
        try {
            localStorage.setItem(key(name), String(value));
        } catch (e) {
            // Storage may be blocked/private.
        }
    }

    function erase(name) {
        try {
            localStorage.removeItem(key(name));
        } catch (e) {
            // Ignore storage errors.
        }
    }

    /* ================================================================
       SYSTEM PREFERENCES
       ================================================================ */

    var mq = window.matchMedia
        ? window.matchMedia.bind(window)
        : function () {
            return {
                matches: false
            };
        };

    var mqDark = mq('(prefers-color-scheme: dark)');
    var mqMotion = mq('(prefers-reduced-motion: reduce)');

    /* ================================================================
       STATE
       ================================================================ */

    var state = {};

    function load() {
        var theme = read('theme');
        var fontSize = read('fontSize');
        var reduceMotion = read('reduceMotion');
        var background = read('background');

        state.background =
            BGS.indexOf(background) !== -1
                ? background
                : 'default';

        state.theme =
            THEMES.indexOf(theme) !== -1
                ? theme
                : 'light';

        state.fontSize =
            SIZES.indexOf(fontSize) !== -1
                ? fontSize
                : 'medium';

        /*
         * If the user has never selected Reduce Motion,
         * follow the operating-system setting.
         */
        state.reduceMotion =
            reduceMotion === null
                ? !!mqMotion.matches
                : reduceMotion === 'true';

        /*
         * Load all other accessibility preferences.
         */
        Object.keys(FLAGS).forEach(function (name) {

            if (name === 'reduceMotion') {
                return;
            }

            state[name] = read(name) === 'true';
        });
    }

    /* ================================================================
       APPLY STATE
       ================================================================ */

    function apply() {

        /*
         * High contrast forces the dark base palette.
         */
        var resolvedTheme =
            state.highContrast
                ? 'dark'
                : (
                    state.theme === 'system'
                        ? (
                            mqDark.matches
                                ? 'dark'
                                : 'light'
                        )
                        : state.theme
                );

        root.setAttribute(
            'data-theme',
            resolvedTheme
        );

        root.setAttribute(
            'data-font-size',
            state.fontSize
        );

        root.setAttribute(
            'data-bg',
            state.background
        );

        /*
         * Apply/remove accessibility classes.
         */
        Object.keys(FLAGS).forEach(function (name) {

            root.classList.toggle(
                FLAGS[name],
                !!state[name]
            );
        });
    }

    /* ================================================================
       SET PREFERENCE
       ================================================================ */

    function set(name, value) {

        /*
         * Accessibility settings are always boolean.
         */
        if (Object.prototype.hasOwnProperty.call(FLAGS, name)) {
            value = !!value;
        }

        state[name] = value;

        write(name, value);

        apply();
        syncControls();
    }

    /* ================================================================
       RESET
       ================================================================ */

    function reset() {

        erase('theme');
        erase('fontSize');
        erase('background');

        Object.keys(FLAGS).forEach(function (name) {
            erase(name);
        });

        load();
        apply();
        syncControls();
    }

    /* ================================================================
       SYNC CONTROLS
       ================================================================ */

    function syncControls() {

        /*
         * Normal controls.
         *
         * Accessibility checkboxes MUST use:
         *
         * <input type="checkbox" data-pref="highContrast">
         */
        document.querySelectorAll(
            '[data-pref]'
        ).forEach(function (element) {

            var name =
                element.getAttribute('data-pref');

            var value = state[name];

            if (element.type === 'checkbox') {

                element.checked = !!value;

            } else if (value !== undefined) {

                element.value = value;
            }
        });

        /*
         * Font size buttons.
         */
        document.querySelectorAll(
            'button[data-font-size]'
        ).forEach(function (button) {

            button.setAttribute(
                'aria-pressed',
                button.dataset.fontSize === state.fontSize
                    ? 'true'
                    : 'false'
            );
        });

        /*
         * Background buttons.
         */
        document.querySelectorAll(
            '.bg-swatch'
        ).forEach(function (button) {

            button.setAttribute(
                'aria-pressed',
                button.dataset.bg === state.background
                    ? 'true'
                    : 'false'
            );
        });
    }

    /* ================================================================
       WIRE CONTROLS
       ================================================================ */

    function wire() {

        function $(id) {
            return document.getElementById(id);
        }

        /*
         * Add data-pref to older controls when necessary.
         */
        Object.keys(LEGACY_IDS).forEach(function (id) {

            var element = $(id);

            if (
                element &&
                !element.hasAttribute('data-pref')
            ) {
                element.setAttribute(
                    'data-pref',
                    LEGACY_IDS[id]
                );
            }
        });

        /* ------------------------------------------------------------
           Normal data-pref controls
           ------------------------------------------------------------ */

        document.querySelectorAll(
            '[data-pref]'
        ).forEach(function (element) {

            /*
             * Prevent duplicate listeners.
             */
            if (
                element.dataset.ltCustomizationBound === 'true'
            ) {
                return;
            }

            element.dataset.ltCustomizationBound = 'true';

            var name =
                element.getAttribute('data-pref');

            element.addEventListener(
                'change',
                function () {

                    /*
                     * CHECKBOX:
                     * use the actual checked state.
                     */
                    if (element.type === 'checkbox') {

                        set(
                            name,
                            element.checked
                        );

                    } else {

                        set(
                            name,
                            element.value
                        );
                    }
                }
            );
        });

        /* ------------------------------------------------------------
           Font-size buttons
           ------------------------------------------------------------ */

        document.querySelectorAll(
            'button[data-font-size]'
        ).forEach(function (button) {

            if (
                button.dataset.ltCustomizationBound === 'true'
            ) {
                return;
            }

            button.dataset.ltCustomizationBound = 'true';

            button.addEventListener(
                'click',
                function () {

                    set(
                        'fontSize',
                        button.dataset.fontSize
                    );
                }
            );
        });

        /* ------------------------------------------------------------
           Background swatches
           ------------------------------------------------------------ */

        document.querySelectorAll(
            '.bg-swatch'
        ).forEach(function (button) {

            if (
                button.dataset.ltCustomizationBound === 'true'
            ) {
                return;
            }

            button.dataset.ltCustomizationBound = 'true';

            button.addEventListener(
                'click',
                function () {

                    set(
                        'background',
                        button.dataset.bg
                    );
                }
            );
        });

        /* ============================================================
           CUSTOMIZATION PANEL
           ============================================================ */

        var btn =
            $('customizationButton');

        var panel =
            $('customizationPanel');

        var closeBtn =
            $('closeCustomization');

        var resetBtn =
            $('resetCustomization');

        function openPanel() {

            if (!panel) {
                return;
            }

            panel.removeAttribute('hidden');

            if (btn) {
                btn.setAttribute(
                    'aria-expanded',
                    'true'
                );
            }

            var first =
                panel.querySelector(
                    'select, button, input'
                );

            if (first) {
                first.focus();
            }
        }

        function closePanel(returnFocus) {

            if (!panel) {
                return;
            }

            panel.setAttribute(
                'hidden',
                ''
            );

            if (btn) {

                btn.setAttribute(
                    'aria-expanded',
                    'false'
                );

                if (returnFocus) {
                    btn.focus();
                }
            }
        }

        /* ------------------------------------------------------------
           Customization button
           ------------------------------------------------------------ */

        if (
            btn &&
            panel &&
            btn.dataset.ltCustomizationBound !== 'true'
        ) {

            btn.dataset.ltCustomizationBound =
                'true';

            btn.addEventListener(
                'click',
                function () {

                    if (
                        panel.hasAttribute('hidden')
                    ) {
                        openPanel();
                    } else {
                        closePanel(false);
                    }
                }
            );
        }

        /* ------------------------------------------------------------
           Close button
           ------------------------------------------------------------ */

        if (
            closeBtn &&
            closeBtn.dataset.ltCustomizationBound !== 'true'
        ) {

            closeBtn.dataset.ltCustomizationBound =
                'true';

            closeBtn.addEventListener(
                'click',
                function () {
                    closePanel(true);
                }
            );
        }

        /* ------------------------------------------------------------
           Reset button
           ------------------------------------------------------------ */

        if (
            resetBtn &&
            resetBtn.dataset.ltCustomizationBound !== 'true'
        ) {

            resetBtn.dataset.ltCustomizationBound =
                'true';

            resetBtn.addEventListener(
                'click',
                function () {
                    reset();
                }
            );
        }

        /* ------------------------------------------------------------
           Click outside panel
           ------------------------------------------------------------ */

        document.addEventListener(
            'click',
            function (event) {

                if (
                    !panel ||
                    panel.hasAttribute('hidden')
                ) {
                    return;
                }

                var insidePanel =
                    panel.contains(event.target);

                var insideButton =
                    btn &&
                    btn.contains(event.target);

                if (
                    !insidePanel &&
                    !insideButton
                ) {
                    closePanel(false);
                }
            }
        );

        /* ------------------------------------------------------------
           Escape key
           ------------------------------------------------------------ */

        document.addEventListener(
            'keydown',
            function (event) {

                if (
                    event.key === 'Escape' &&
                    panel &&
                    !panel.hasAttribute('hidden')
                ) {
                    closePanel(true);
                }
            }
        );

        /*
         * Initial synchronization.
         */
        syncControls();
    }

    /* ================================================================
       BOOT
       ================================================================ */

    load();

    /*
     * Apply immediately when script is loaded in <head>.
     */
    apply();

    /* ================================================================
       SYSTEM THEME CHANGES
       ================================================================ */

    function onSystemChange() {

        if (state.theme === 'system') {
            apply();
        }
    }

    if (mqDark.addEventListener) {

        mqDark.addEventListener(
            'change',
            onSystemChange
        );

    } else if (mqDark.addListener) {

        mqDark.addListener(
            onSystemChange
        );
    }

    /* ================================================================
       SYSTEM REDUCED-MOTION CHANGES
       ================================================================ */

    function onMotionChange(event) {

        /*
         * Only follow the OS when the user has not
         * manually selected Reduce Motion.
         */
        if (read('reduceMotion') === null) {

            state.reduceMotion =
                !!event.matches;

            apply();
            syncControls();
        }
    }

    if (mqMotion.addEventListener) {

        mqMotion.addEventListener(
            'change',
            onMotionChange
        );

    } else if (mqMotion.addListener) {

        mqMotion.addListener(
            onMotionChange
        );
    }

    /* ================================================================
       START
       ================================================================ */

    if (
        document.readyState === 'loading'
    ) {

        document.addEventListener(
            'DOMContentLoaded',
            wire
        );

    } else {

        wire();
    }

    /* ================================================================
       PUBLIC API
       ================================================================ */

    window.LTCustomize = {
        set: set,
        reset: reset,
        state: state
    };

})();

