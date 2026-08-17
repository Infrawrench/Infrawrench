//! Reaching keysyms the layout has no key for.
//!
//! The host's keymap is `us`, and a client on any other layout will eventually
//! ask for a character it cannot produce — `£` on a UK keyboard, every accent
//! on a French one, anything an input method composed. There is no keycode to
//! send for those, so the compositor makes one: a spare keycode is bound to the
//! keysym, the keymap is handed to the application again, and the key is
//! pressed.
//!
//! Two things make that affordable. The bindings accumulate rather than being
//! swapped per keystroke — a language's worth of accents is a handful of keys,
//! and after the first few nothing changes. And the new keymap is built by
//! *appending* to the one xkbcommon already compiled, rather than by asking it
//! to resolve `include` directives again: the text this produces is
//! self-contained, so a host with no `xkeyboard-config` installed cannot lose a
//! working keyboard to a failed recompile.
//!
//! Everything here is string manipulation, deliberately: it builds and tests on
//! a machine with no Wayland at all, and only the compile itself is Linux's.

/// First evdev keycode used for a bound keysym.
///
/// Above every key a real keyboard reports and below the 255 an xkb keymap can
/// address once the eight-code offset is applied.
pub const FIRST_SPARE: u32 = 200;

/// How many keysyms can be bound at once.
///
/// Enough for a language's accented set several times over. Past it the oldest
/// binding is reused, which costs a keymap rebuild the next time that character
/// is typed and nothing else.
pub const MAX_SPARE: usize = 40;

/// The keysyms currently bound to spare keycodes.
#[derive(Debug, Default)]
pub struct SpareKeys {
    /// Position is the offset from [`FIRST_SPARE`]; the value is the keysym.
    bound: Vec<u32>,
    /// Where the next binding goes once every slot is in use.
    next: usize,
}

impl SpareKeys {
    pub fn new() -> Self {
        Self::default()
    }

    /// The keycode for `keysym`, and whether the keymap has to be rebuilt.
    ///
    /// Rebuilding is the expensive half — every client recompiles — so a
    /// keysym that is already bound returns `false` and costs nothing.
    pub fn bind(&mut self, keysym: u32) -> (u32, bool) {
        if let Some(index) = self.bound.iter().position(|&s| s == keysym) {
            return (FIRST_SPARE + index as u32, false);
        }
        if self.bound.len() < MAX_SPARE {
            self.bound.push(keysym);
            return (FIRST_SPARE + (self.bound.len() - 1) as u32, true);
        }
        // Full: take the oldest slot. The character bound there has to be
        // re-bound if it comes back, which is a rebuild rather than a failure.
        let index = self.next % MAX_SPARE;
        self.next = index + 1;
        self.bound[index] = keysym;
        (FIRST_SPARE + index as u32, true)
    }

    /// Every binding, as `(evdev keycode, keysym)`.
    pub fn bindings(&self) -> impl Iterator<Item = (u32, u32)> + '_ {
        self.bound
            .iter()
            .enumerate()
            .map(|(i, &sym)| (FIRST_SPARE + i as u32, sym))
    }

    pub fn is_empty(&self) -> bool {
        self.bound.is_empty()
    }
}

/// Add keys to a compiled keymap's text.
///
/// `keys` is `(evdev keycode, keysym name)`. Returns `None` when the text is
/// not a keymap this understands, which is a reason to keep the keyboard that
/// works rather than to replace it with one that might not.
pub fn inject(base: &str, keys: &[(u32, String)]) -> Option<String> {
    if keys.is_empty() {
        return Some(base.to_owned());
    }

    let mut out = base.to_owned();

    // Symbols first: editing the later section leaves the earlier section's
    // offsets, which the keycode insertion still needs, untouched.
    let symbols_end = section_end(&out, "xkb_symbols")?;
    let mut symbols = String::new();
    for (code, name) in keys {
        // ONE_LEVEL so the symbol is whatever modifiers happen to be held. A
        // key bound to a single keysym has no shifted form to offer, and a
        // client holding Shift would otherwise reach a level that is not there.
        symbols.push_str(&format!(
            "    key <IW{code}> {{ type[Group1]=\"ONE_LEVEL\", [ {name} ] }};\n"
        ));
    }
    out.insert_str(symbols_end, &symbols);

    let keycodes_end = section_end(&out, "xkb_keycodes")?;
    let mut keycodes = String::new();
    for (code, _) in keys {
        // The eight-code offset between evdev and xkb, which exists because X
        // could not use keycodes below 8.
        keycodes.push_str(&format!("    <IW{code}> = {};\n", code + 8));
    }
    out.insert_str(keycodes_end, &keycodes);

    // A keymap declares the range it addresses, and a key outside it is
    // dropped silently by some clients rather than rejected by the compile.
    let highest = keys.iter().map(|(code, _)| code + 8).max().unwrap_or(0);
    Some(raise_maximum(out, highest))
}

/// The offset of a named section's closing brace, so lines can be added to it.
fn section_end(text: &str, section: &str) -> Option<usize> {
    let start = text.find(section)?;
    let open = text[start..].find('{')? + start;
    let mut depth = 0usize;
    for (offset, byte) in text[open..].bytes().enumerate() {
        match byte {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(open + offset);
                }
            }
            _ => {}
        }
    }
    None
}

/// Widen the keymap's declared keycode range if the new keys fall outside it.
fn raise_maximum(text: String, highest: u32) -> String {
    let Some(at) = text.find("maximum = ") else {
        return text;
    };
    let rest = &text[at + "maximum = ".len()..];
    let Some(end) = rest.find(';') else {
        return text;
    };
    let Ok(current) = rest[..end].trim().parse::<u32>() else {
        return text;
    };
    if current >= highest {
        return text;
    }
    let mut out = String::with_capacity(text.len() + 8);
    out.push_str(&text[..at + "maximum = ".len()]);
    out.push_str(&highest.to_string());
    out.push_str(&rest[end..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape xkbcommon dumps: sections in order, braces nested one deep.
    const BASE: &str = "xkb_keymap {
xkb_keycodes \"(unnamed)\" {
    minimum = 8;
    maximum = 255;
    <ESC> = 9;
};

xkb_types \"(unnamed)\" {
    type \"ONE_LEVEL\" { modifiers= none; };
};

xkb_symbols \"(unnamed)\" {
    key <ESC> { [ Escape ] };
};

};
";

    #[test]
    fn a_keysym_keeps_its_keycode_and_costs_one_rebuild() {
        let mut spare = SpareKeys::new();
        assert_eq!(spare.bind(0x00a3), (FIRST_SPARE, true));
        // The second time it is already there, and a rebuild means every
        // client recompiling a keymap.
        assert_eq!(spare.bind(0x00a3), (FIRST_SPARE, false));
        assert_eq!(spare.bind(0x00e9), (FIRST_SPARE + 1, true));
    }

    #[test]
    fn a_full_table_reuses_the_oldest_slot() {
        let mut spare = SpareKeys::new();
        for i in 0..MAX_SPARE as u32 {
            assert_eq!(spare.bind(0x1000 + i), (FIRST_SPARE + i, true));
        }
        // Nothing is lost that cannot be re-bound; the cost is a rebuild.
        assert_eq!(spare.bind(0x2000), (FIRST_SPARE, true));
        assert_eq!(spare.bind(0x2001), (FIRST_SPARE + 1, true));
        assert_eq!(spare.bindings().count(), MAX_SPARE);
    }

    #[test]
    fn injecting_puts_each_key_in_both_sections() {
        let out = inject(BASE, &[(200, "sterling".into())]).expect("the base is a keymap");
        assert!(out.contains("<IW200> = 208;"), "keycode missing:\n{out}");
        assert!(
            out.contains("key <IW200> { type[Group1]=\"ONE_LEVEL\", [ sterling ] };"),
            "symbol missing:\n{out}"
        );
        // And leaves what was already there alone.
        assert!(out.contains("<ESC> = 9;"));
        assert!(out.contains("key <ESC> { [ Escape ] };"));
    }

    #[test]
    fn a_keycode_goes_in_the_keycodes_section_and_not_the_symbols_one() {
        let out = inject(BASE, &[(200, "sterling".into())]).unwrap();
        let keycodes = out.find("xkb_keycodes").unwrap();
        let symbols = out.find("xkb_symbols").unwrap();
        let assignment = out.find("<IW200> = 208;").unwrap();
        let symbol = out.find("key <IW200>").unwrap();
        assert!(assignment > keycodes && assignment < symbols);
        assert!(symbol > symbols);
    }

    #[test]
    fn the_declared_range_grows_to_fit() {
        // A keymap that stops at 255 cannot address the keys we just added.
        let narrow = BASE.replace("maximum = 255;", "maximum = 120;");
        let out = inject(&narrow, &[(200, "sterling".into())]).unwrap();
        assert!(out.contains("maximum = 208;"), "{out}");
    }

    #[test]
    fn a_range_that_already_fits_is_left_alone() {
        let out = inject(BASE, &[(200, "sterling".into())]).unwrap();
        assert!(out.contains("maximum = 255;"));
    }

    #[test]
    fn several_keys_all_arrive() {
        let keys = vec![
            (200, "sterling".into()),
            (201, "eacute".into()),
            (202, "U20AC".into()),
        ];
        let out = inject(BASE, &keys).unwrap();
        for (code, name) in &keys {
            assert!(out.contains(&format!("<IW{code}> = {};", code + 8)));
            assert!(out.contains(&format!("[ {name} ]")));
        }
    }

    #[test]
    fn nothing_to_add_is_the_keymap_unchanged() {
        assert_eq!(inject(BASE, &[]).as_deref(), Some(BASE));
    }

    #[test]
    fn text_that_is_not_a_keymap_is_refused_rather_than_mangled() {
        // Better to keep the keyboard that works than to install one built
        // from something this did not understand.
        assert!(inject("not a keymap", &[(200, "sterling".into())]).is_none());
        assert!(inject("xkb_symbols { unclosed", &[(200, "a".into())]).is_none());
    }
}
