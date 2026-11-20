/**
 * Runtime patch for the InputChannel of xbox-xcloud-player@0.2.11 (mouse & keyboard mode).
 *
 * Fixes / adds:
 *  - Mouse sensitivity: the library hardcodes `movementX * 10` and always asks for raw input
 *    (unadjustedMovement), which ignores the OS pointer speed. Now the multiplier is configurable
 *    and raw input is optional (default: follow the OS pointer settings).
 *  - Mouse wheel: `onPointerScroll` in the library does nothing. Now it sends wheel frames.
 *  - Arrow keys: in mouse & keyboard mode (no controller emulation) the library only sends raw VK
 *    keyboard frames, which menus/the console UI ignore. Arrow keys now also press the D-pad.
 *
 * Preferences (set from the DevTools console, read when used, no restart needed):
 *   localStorage.setItem('mkb_sensitivity', '10')      // multiplier, library default is 10
 *   localStorage.setItem('mkb_raw_input', 'false')     // 'true' = raw input, ignores OS pointer speed
 *   localStorage.setItem('mkb_invert_scroll', 'false') // 'true' if the wheel direction is reversed
 *   localStorage.setItem('mkb_arrows_dpad', 'true')    // 'false' = arrows only as keyboard keys
 */

const PATCH_FLAG = '__greenlightMkbPatched'

const ARROW_TO_DPAD: Record<string, string> = {
    ArrowUp: 'DPadUp',
    ArrowDown: 'DPadDown',
    ArrowLeft: 'DPadLeft',
    ArrowRight: 'DPadRight',
}

const LIBRARY_SENSITIVITY = 10 // multiplier hardcoded in the library
const WHEEL_NOTCH_PIXELS = 100 // browsers report about 100px per wheel notch
const WHEEL_DELTA = 120 // one wheel notch on the console side (Windows WHEEL_DELTA)

function readPref(key: string, fallback: string): string {
    try {
        const value = window.localStorage.getItem(key)
        return value === null ? fallback : value
    } catch (e) {
        return fallback
    }
}

export function getMouseSensitivity(): number {
    const value = parseFloat(readPref('mkb_sensitivity', String(LIBRARY_SENSITIVITY)))
    return Number.isFinite(value) && value > 0 ? value : LIBRARY_SENSITIVITY
}

export function isRawMouseInput(): boolean {
    return readPref('mkb_raw_input', 'false') === 'true'
}

export function isScrollInverted(): boolean {
    return readPref('mkb_invert_scroll', 'false') === 'true'
}

export function areArrowsDpad(): boolean {
    return readPref('mkb_arrows_dpad', 'true') === 'true'
}

export function patchInputChannel(input: any): void {
    const proto = Object.getPrototypeOf(input)
    if (proto === undefined || proto === null || proto[PATCH_FLAG] === true) {
        return
    }
    proto[PATCH_FLAG] = true

    // --- Pointer lock: honour the raw / OS pointer speed preference ---
    proto.requestPointerLockWithUnadjustedMovement = function (element: HTMLElement) {
        if ('keyboard' in navigator && 'lock' in (navigator as any).keyboard) {
            document.body.requestFullscreen().then(() => {
                (navigator as any).keyboard.lock()
            }).catch(() => {
                // The app window is already fullscreen, nothing to do
            })
        }

        const lock = async () => {
            if (isRawMouseInput()) {
                try {
                    await (element as any).requestPointerLock({ unadjustedMovement: true })
                    return
                } catch (e) {
                    console.log('[MKB] Raw mouse input not available, using OS pointer settings:', e)
                }
            }
            await (element as any).requestPointerLock()
        }

        return lock().then(() => {
            console.log('[MKB] pointer is locked')
            this._mouseLocked = true
        }).catch((error: any) => {
            // Same behaviour as the library: keep mouse input flowing even if the lock was refused
            console.log('[MKB] Pointer lock failed:', error)
            this._mouseLocked = true
        })
    }

    // --- Mouse sensitivity: rescale the frames the library just queued ---
    const scaleNewMouseFrames = (channel: any, startIndex: number) => {
        const factor = getMouseSensitivity() / LIBRARY_SENSITIVITY
        if (factor === 1) {
            return
        }

        for (let i = startIndex; i < channel._mouseFrames.length; i++) {
            const frame = channel._mouseFrames[i]
            frame.X = Math.round(frame.X * factor)
            frame.Y = Math.round(frame.Y * factor)
        }
    }

    for (const name of ['onPointerMove', 'onPointerClick']) {
        const original = proto[name]
        proto[name] = function (event: PointerEvent) {
            const before = this._mouseFrames.length
            original.call(this, event)
            scaleNewMouseFrames(this, before)
        }
    }

    // --- Mouse wheel ---
    let wheelRemainder = 0

    proto.onPointerScroll = function (event: WheelEvent) {
        event.preventDefault()

        if (this._mouseLocked !== true) {
            return
        }

        const pixels = event.deltaMode === 1 ? event.deltaY * 40 : event.deltaMode === 2 ? event.deltaY * 800 : event.deltaY
        wheelRemainder += pixels

        const notches = Math.trunc(wheelRemainder / WHEEL_NOTCH_PIXELS)
        if (notches === 0) {
            return
        }
        wheelRemainder -= notches * WHEEL_NOTCH_PIXELS

        // Browser: deltaY > 0 = scrolling down. Console side: positive = wheel up.
        const direction = isScrollInverted() ? 1 : -1

        this._mouseFrames.push({
            X: 0,
            Y: 0,
            WheelX: 0,
            WheelY: direction * notches * WHEEL_DELTA,
            Buttons: event.buttons,
            Relative: 0, // 0 = Relative, 1 = Absolute
        })
    }

    // --- Arrow keys also press the D-pad (menus) ---
    const originalKeyDown = proto.onKeyDown
    proto.onKeyDown = function (event: KeyboardEvent) {
        originalKeyDown.call(this, event)

        const dpadButton = ARROW_TO_DPAD[event.key]
        const config = this._client._config

        // With controller emulation on, the keyboard driver already maps arrows to the D-pad
        if (dpadButton !== undefined && areArrowsDpad() && config.input_mousekeyboard === true && config.input_legacykeyboard === false) {
            event.preventDefault()
            this.pressButton(0, dpadButton)
        }
    }
}
