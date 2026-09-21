/**
 * src/components/BottomNav.jsx
 * P1.5: Fixed bottom navigation bar with safe-area insets.
 *
 * - pb-[env(safe-area-inset-bottom,0px)]: clears iOS Home Indicator (34px)
 * - h-[calc(64px+env(safe-area-inset-bottom,0px))]: exact height
 * - All touch targets >= 48x48px (WCAG 2.5.5 / Apple HIG)
 * - Raised center FAB for "مصروف" action
 */
import React from 'react';
import { Home, ClipboardList, PlusCircle, Package, Store } from 'lucide-react';

const NAV_ITEMS = [
  { id: 'live',      label: 'الرئيسية',  Icon: Home },
  { id: 'shifts',    label: 'الورديات',  Icon: ClipboardList },
  { id: 'expenses',  label: 'مصروف',     Icon: PlusCircle,  isFab: true },
  { id: 'inventory', label: 'المخزون',   Icon: Package },
  { id: 'branches',  label: 'الفروع',    Icon: Store },
];

export function BottomNav({ activeTab, onTabChange }) {
  return (
    <nav
      className="fixed bottom-0 inset-x-0 z-50 bg-white/95 backdrop-blur-md border-t border-subtle pb-[env(safe-area-inset-bottom,0px)] h-[calc(64px+env(safe-area-inset-bottom,0px))] shadow-lg"
      aria-label="شريط التنقل الرئيسي"
    >
      <div className="h-16 max-w-lg mx-auto px-2 flex items-center justify-around relative">
        {NAV_ITEMS.map(({ id, label, Icon, isFab }) => {
          const isActive = activeTab === id;

          if (isFab) {
            return (
              <button
                key={id}
                onClick={() => onTabChange(id)}
                className="relative -top-5 flex flex-col items-center group focus:outline-none"
                aria-label="إضافة مصروف جديد"
              >
                <div className="w-14 h-14 rounded-full bg-primary text-white flex items-center justify-center shadow-lg shadow-primary/30 group-active:scale-95 transition-transform">
                  <Icon size={28} strokeWidth={2.5} />
                </div>
                <span className="text-[10px] font-bold text-primary mt-1">{label}</span>
              </button>
            );
          }

          return (
            <button
              key={id}
              onClick={() => onTabChange(id)}
              className={`flex flex-col items-center justify-center min-w-[56px] min-h-[48px] rounded-xl transition-colors ${
                isActive ? 'text-primary' : 'text-muted hover:text-main'
              }`}
              aria-current={isActive ? 'page' : undefined}
            >
              <Icon
                size={22}
                strokeWidth={isActive ? 2.5 : 2}
                className={isActive ? 'text-primary' : ''}
              />
              <span className={`text-[10px] mt-1 leading-none ${isActive ? 'font-bold' : 'font-medium'}`}>
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export default BottomNav;
