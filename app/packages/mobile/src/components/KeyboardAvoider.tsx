import { useRef, useState, type ReactNode } from "react";
import { KeyboardAvoidingView, Platform, View, type StyleProp, type ViewStyle } from "react-native";

/**
 * KeyboardAvoidingView with a measured keyboardVerticalOffset. A static
 * offset can't be right here: screens sit under different navigator chrome
 * (tab header, nested stack header, both, or neither), so the distance from
 * the window top varies per screen. Measure the view's actual window position
 * and use that as the offset.
 */
export function KeyboardAvoider({
  style,
  children,
}: {
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const rootRef = useRef<View>(null);
  const [offset, setOffset] = useState(0);

  return (
    <View
      ref={rootRef}
      style={{ flex: 1 }}
      onLayout={() => {
        rootRef.current?.measureInWindow((_x, y) => setOffset(y));
      }}
    >
      <KeyboardAvoidingView
        style={[{ flex: 1 }, style]}
        {...(Platform.OS === "ios"
          ? { behavior: "padding" as const, keyboardVerticalOffset: offset }
          : {})}
      >
        {children}
      </KeyboardAvoidingView>
    </View>
  );
}
