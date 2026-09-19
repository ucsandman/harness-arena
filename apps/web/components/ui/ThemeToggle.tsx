'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { THEME_STORAGE_KEY, type ThemeChoice } from '@/lib/theme';

const ORDER: ThemeChoice[] = ['system', 'light', 'dark'];

const LABEL: Record<ThemeChoice, string> = {
  system: 'System theme',
  light: 'Light theme',
  dark: 'Dark theme',
};

function resolve(choice: ThemeChoice): 'light' | 'dark' {
  if (choice !== 'system') return choice;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function apply(choice: ThemeChoice) {
  const resolved = resolve(choice);
  document.documentElement.setAttribute('data-theme', resolved);
  try {
    if (choice === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // private mode: the choice simply does not persist
  }
}

export function ThemeToggle({ className }: { className?: string }) {
  const [choice, setChoice] = useState<ThemeChoice>('system');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      stored = null;
    }
    setChoice(stored === 'light' || stored === 'dark' ? stored : 'system');
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted || choice !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [choice, mounted]);

  const next = () => {
    const index = ORDER.indexOf(choice);
    const value = ORDER[(index + 1) % ORDER.length] ?? 'system';
    setChoice(value);
    apply(value);
  };

  const Icon = choice === 'system' ? Monitor : choice === 'dark' ? Moon : Sun;

  return (
    <button
      type="button"
      onClick={next}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-fg-muted ' +
          'hover:bg-bg-subtle hover:text-fg',
        className,
      )}
      aria-label={`${LABEL[choice]}. Activate to switch.`}
      title={LABEL[choice]}
    >
      <Icon size={15} aria-hidden="true" />
    </button>
  );
}
