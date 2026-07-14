import { useState } from "react";
import type { Screen } from "./types";
import { ComatoDataProvider } from "./data/context";
import { useIsDesktop } from "./lib/useIsDesktop";
import AmbientBackground from "./components/AmbientBackground";
import PhoneFrame from "./components/PhoneFrame";
import TabBar from "./components/TabBar";
import HomeScreen from "./screens/HomeScreen";
import PositionScreen from "./screens/PositionScreen";
import ActivityScreen from "./screens/ActivityScreen";
import AccountScreen from "./screens/AccountScreen";
import DesktopApp from "./desktop/DesktopApp";

export default function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const isDesktop = useIsDesktop();

  return (
    <ComatoDataProvider>
      {/* Shared frosted-over-ambient canvas for both layouts */}
      <AmbientBackground />

      {isDesktop ? (
        <DesktopApp screen={screen} onNavigate={setScreen} />
      ) : (
        <PhoneFrame>
          {/* Scroll area — keyed by screen so it resets scroll + replays entrance */}
          <main
            key={screen}
            className="no-scrollbar flex-1 overflow-y-auto pb-28 pt-[max(0.5rem,env(safe-area-inset-top))]"
          >
            {screen === "home" && <HomeScreen onNavigate={setScreen} />}
            {screen === "position" && <PositionScreen onNavigate={setScreen} />}
            {screen === "activity" && <ActivityScreen />}
            {screen === "account" && <AccountScreen />}
          </main>

          <TabBar active={screen} onChange={setScreen} />
        </PhoneFrame>
      )}
    </ComatoDataProvider>
  );
}
