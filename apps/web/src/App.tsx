import { useState } from "react";
import { MotionConfig } from "framer-motion";
import type { Screen } from "./types";
import { ComatoDataProvider } from "./data/context";
import { WalletProvider } from "./data/wallet";
import { useIsDesktop } from "./lib/useIsDesktop";
import { motion, AnimatePresence, screenFade } from "./lib/motion";
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
    // reducedMotion="user" makes every motion component honour the OS setting:
    // transforms/layout are stripped, opacity is kept. Imperative helpers
    // (count-up, path-draw) additionally branch on useReducedMotion().
    <MotionConfig reducedMotion="user">
      <WalletProvider>
        <ComatoDataProvider>
          {/* Shared frosted-over-ambient canvas for both layouts */}
          <AmbientBackground />

        {isDesktop ? (
          <DesktopApp screen={screen} onNavigate={setScreen} />
        ) : (
          <PhoneFrame>
            {/* Scroll area — keyed by screen so it resets scroll, cross-fades,
                and replays the staggered entrance on every tab switch. */}
            <AnimatePresence mode="wait" initial={false}>
              <motion.main
                key={screen}
                variants={screenFade}
                initial="initial"
                animate="animate"
                exit="exit"
                className="no-scrollbar flex-1 overflow-y-auto pb-28 pt-[max(0.5rem,env(safe-area-inset-top))]"
              >
                {screen === "home" && <HomeScreen onNavigate={setScreen} />}
                {screen === "position" && (
                  <PositionScreen onNavigate={setScreen} />
                )}
                {screen === "activity" && <ActivityScreen />}
                {screen === "account" && <AccountScreen />}
              </motion.main>
            </AnimatePresence>

            <TabBar active={screen} onChange={setScreen} />
          </PhoneFrame>
        )}
        </ComatoDataProvider>
      </WalletProvider>
    </MotionConfig>
  );
}
