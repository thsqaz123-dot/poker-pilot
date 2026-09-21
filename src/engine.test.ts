import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyAction, availableActions, buildSidePots, confirmBoardDealt, settleShowdown, startHand, voidCurrentHand } from './engine'
import type { Game, Seat } from './types'

const seat = (id: string, position: number, stack = 10_000): Seat => ({
  id, profileId: id, name: id.toUpperCase(), seat: position, stack, state: 'active',
  sittingOutNextHand: false, joinedAtHand: 0, streetBet: 0, totalBet: 0,
})

const game = (seats = [seat('a', 0), seat('b', 1), seat('c', 2)]): Game => ({
  id: 'g', createdAt: '', smallBlind: 50, bigBlind: 100, phase: 'between-hands',
  street: 'preflop', handNumber: 0, buttonSeat: 0, currentActorId: null, currentBet: 0,
  minRaise: 100, seats, needsAction: [], lastActedBet: {}, logs: [],
})

describe('poker engine', () => {
  it('posts blinds and starts left of the big blind for 3 players', () => {
    const next = startHand(game())
    assert.equal(next.currentActorId, 'a')
    assert.deepEqual(next.seats.map((s) => s.stack), [10_000, 9_950, 9_900])
    assert.equal(next.currentBet, 100)
    assert.equal(next.seats.every((s) => (s.handsPlayed ?? 0) === 0), true)
  })

  it('uses the logical button as small blind and first actor heads-up', () => {
    const next = startHand(game([seat('a', 0), seat('b', 1)]))
    assert.equal(next.currentActorId, 'a')
    assert.equal(next.seats[0].streetBet, 50)
    assert.equal(next.seats[1].streetBet, 100)
  })

  it('advances to the flop after calls and a big-blind check', () => {
    let next = startHand(game())
    next = applyAction(next, { type: 'call' })
    next = applyAction(next, { type: 'call' })
    next = applyAction(next, { type: 'check' })
    assert.equal(next.street, 'flop')
    assert.equal(next.awaitingBoard, true)
    assert.equal(next.currentActorId, 'b')
    assert.equal(next.seats.every((s) => s.streetBet === 0), true)
  })

  it('builds main and side pots and distributes them', () => {
    const source = game([seat('a', 0), seat('b', 1), seat('c', 2)])
    source.phase = 'showdown'
    source.street = 'showdown'
    source.seats[0].totalBet = 1_000
    source.seats[1].totalBet = 2_000
    source.seats[2].totalBet = 2_000
    const pots = buildSidePots(source)
    assert.deepEqual(pots.map((p) => p.amount), [3_000, 2_000])
    const settled = settleShowdown(source, { 'pot-0': ['a'], 'pot-1': ['b'] })
    assert.deepEqual(settled.seats.map((s) => s.stack), [13_000, 12_000, 10_000])
    assert.equal(settled.seats.find((s) => s.id === 'a')?.handsWon, 1)
    assert.equal(settled.seats.find((s) => s.id === 'b')?.handsWon, 1)
  })

  it('ends immediately when everyone else folds', () => {
    let next = startHand(game())
    next = applyAction(next, { type: 'fold' })
    next = applyAction(next, { type: 'fold' })
    assert.equal(next.phase, 'between-hands')
    assert.equal(next.seats.find((s) => s.id === 'c')?.stack, 10_050)
    assert.equal(next.seats.find((s) => s.id === 'c')?.handsWon, 1)
    assert.equal(next.seats.every((s) => s.handsPlayed === 1), true)
  })

  it('does not reopen raising after a short all-in', () => {
    let next = startHand(game([seat('a', 0), seat('b', 1), seat('c', 2, 150)]))
    next = applyAction(next, { type: 'call' })
    next = applyAction(next, { type: 'call' })
    next = applyAction(next, { type: 'all-in' })
    assert.equal(next.currentActorId, 'a')
    assert.equal(next.currentBet, 150)
    assert.equal(next.lastActedBet.a, 100)
    assert.throws(() => applyAction(next, { type: 'all-in' }), /선택할 수 없는 행동/)
  })

  it('awards an odd cent to the first winner left of the button with empty seat numbers', () => {
    const source = game([seat('a', 0), seat('b', 3), seat('c', 5)])
    source.phase = 'showdown'
    source.street = 'showdown'
    source.buttonSeat = 3
    source.seats.forEach((s) => { s.totalBet = 1 })
    const settled = settleShowdown(source, { 'pot-0': ['a', 'c'] })
    assert.equal(settled.seats.find((s) => s.id === 'c')?.stack, 10_002)
    assert.equal(settled.seats.find((s) => s.id === 'a')?.stack, 10_001)
  })

  it('can start the next hand after confirming a showdown winner', () => {
    let next = startHand(game([seat('a', 0), seat('b', 1)]))
    next = applyAction(next, { type: 'call' })
    next = applyAction(next, { type: 'check' })
    for (let street = 0; street < 3; street += 1) {
      next = confirmBoardDealt(next)
      next = applyAction(next, { type: 'check' })
      next = applyAction(next, { type: 'check' })
    }
    assert.equal(next.phase, 'showdown')
    const settled = settleShowdown(next, { 'pot-0': ['a'] })
    assert.equal(settled.phase, 'between-hands')
    const following = startHand(settled)
    assert.equal(following.phase, 'playing')
    assert.equal(following.handNumber, 2)
  })

  it('requires all five community cards before an all-in showdown', () => {
    let next = startHand(game([seat('a', 0, 100), seat('b', 1, 100)]))
    next = applyAction(next, { type: 'call' })
    assert.equal(next.phase, 'showdown')
    assert.equal(next.awaitingBoard, true)
    assert.equal(next.communityCardsRevealed, 0)
    assert.throws(() => settleShowdown(next, { 'pot-0': ['a'] }), /공용 카드 5장/)
    next = confirmBoardDealt(next)
    assert.equal(next.awaitingBoard, false)
    assert.equal(next.communityCardsRevealed, 5)
  })

  it('voids a live hand and returns every contribution', () => {
    let next = startHand(game())
    next = applyAction(next, { type: 'call' })
    assert.equal(next.seats.reduce((sum, s) => sum + s.totalBet, 0), 250)
    const cancelled = voidCurrentHand(next)
    assert.equal(cancelled.phase, 'between-hands')
    assert.deepEqual(cancelled.seats.map((s) => s.stack), [10_000, 10_000, 10_000])
    assert.equal(cancelled.seats.every((s) => s.totalBet === 0), true)
    const redealt = startHand(cancelled)
    assert.equal(redealt.handNumber, 1)
    assert.equal(redealt.buttonSeat, 0)
    assert.equal(redealt.seats.every((s) => (s.handsPlayed ?? 0) === 0), true)
  })

  it('keeps the nominal bring-in when the big blind is all-in short', () => {
    let next = startHand(game([seat('a', 0), seat('b', 1), seat('c', 2, 50)]))
    assert.equal(next.currentBet, 100)
    assert.equal(next.currentActorId, 'a')
    next = applyAction(next, { type: 'call' })
    assert.equal(next.seats.find((s) => s.id === 'a')?.streetBet, 100)
  })

  it('allows only fold or call when every opponent is all-in', () => {
    const next = startHand(game([seat('a', 0, 1_000), seat('b', 1, 50)]))
    assert.deepEqual(availableActions(next, 'a'), ['fold', 'call'])
    assert.throws(() => applyAction(next, { type: 'raise', total: 200 }), /선택할 수 없는 행동/)
    assert.throws(() => applyAction(next, { type: 'all-in' }), /선택할 수 없는 행동/)
  })

  it('posts one live big blind when a player joins or returns', () => {
    const returning = seat('a', 0)
    returning.owesEntryBlind = true
    const next = startHand(game([returning, seat('b', 1), seat('c', 2)]))
    assert.equal(next.seats.find((s) => s.id === 'a')?.streetBet, 100)
    assert.equal(next.seats.find((s) => s.id === 'a')?.owesEntryBlind, false)
    assert.equal(next.currentBet, 100)
  })

  it('reopens raising after cumulative short all-ins reach a full raise', () => {
    const source = game([seat('a', 0), seat('b', 1, 125), seat('c', 2), seat('d', 3, 200), seat('e', 4)])
    source.phase = 'playing'; source.street = 'flop'; source.currentActorId = 'a'; source.needsAction = ['a', 'b', 'c', 'd', 'e']
    let next = applyAction(source, { type: 'bet', total: 100 })
    next = applyAction(next, { type: 'all-in' })
    next = applyAction(next, { type: 'call' })
    next = applyAction(next, { type: 'all-in' })
    next = applyAction(next, { type: 'call' })
    assert.equal(next.currentActorId, 'a')
    assert.equal(availableActions(next, 'a').includes('raise'), true)
    next = applyAction(next, { type: 'call' })
    assert.equal(next.currentActorId, 'c')
    assert.equal(availableActions(next, 'c').includes('raise'), false)
  })
})
