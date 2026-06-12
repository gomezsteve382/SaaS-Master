// @vitest-environment jsdom
import React from 'react';
import { describe, it, afterEach, expect } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import Section from '../Section.jsx';

describe('Section — collapsible block', () => {
  afterEach(cleanup);

  it('defaults open and shows its children + title', () => {
    render(<Section title="DETAILS" testid="sec"><p>body text</p></Section>);
    expect(screen.getByText('DETAILS')).toBeTruthy();
    expect(screen.getByText('body text')).toBeTruthy();
  });

  it('toggles children on header click', () => {
    render(<Section title="DETAILS" testid="sec"><p>body text</p></Section>);
    act(() => { fireEvent.click(screen.getByTestId('sec-toggle')); });
    expect(screen.queryByText('body text')).toBeNull(); // collapsed
    act(() => { fireEvent.click(screen.getByTestId('sec-toggle')); });
    expect(screen.getByText('body text')).toBeTruthy(); // re-expanded
  });

  it('respects defaultOpen={false} but keeps the title visible', () => {
    render(<Section title="WRITE SEMANTICS" defaultOpen={false} testid="sec"><p>hidden detail</p></Section>);
    expect(screen.getByText('WRITE SEMANTICS')).toBeTruthy(); // headline always visible
    expect(screen.queryByText('hidden detail')).toBeNull();   // body collapsed
  });

  it('renders an optional badge', () => {
    render(<Section title="T" badge={7} testid="sec"><p>x</p></Section>);
    expect(screen.getByText('7')).toBeTruthy();
  });
});
