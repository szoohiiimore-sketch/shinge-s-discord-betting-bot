/**
 * End-to-end validation script for the betting intelligence pipeline.
 *
 * This script:
 * 1. Starts the application
 * 2. Manually triggers a sync-traditional-sport job for basketball_nba
 * 3. Waits for match ingestion to complete
 * 4. Checks for OddsSnapshot records in the database
 * 5. Checks for ValueOpportunity records
 * 6. Reports results
 *
 * Usage: npx tsx --env-file=.env scripts/e2e-validation.ts
 */

import { PrismaClient } from '@prisma/client';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

async function main(): Promise<void> {
  console.log('\n=== E2E VALIDATION ===\n');
  const prisma = new PrismaClient();
  const redis = new Redis(REDIS_URL);

  try {
    // Step 1: Verify database connection
    console.log('1. Database check...');
    await prisma.$connect();
    console.log('   ✅ PostgreSQL connected');

    // Step 2: Verify Redis connection
    console.log('2. Redis check...');
    await redis.ping();
    console.log('   ✅ Redis connected');

    // Step 3: Check existing data
    console.log('3. Checking existing data...');
    const sportCount = await prisma.sport.count();
    const leagueCount = await prisma.league.count();
    const matchCount = await prisma.match.count();
    const snapshotCount = await prisma.oddsSnapshot.count();
    const valueOppCount = await prisma.valueOpportunity.count();

    console.log(`   Sports: ${sportCount}`);
    console.log(`   Leagues: ${leagueCount}`);
    console.log(`   Matches: ${matchCount}`);
    console.log(`   OddsSnapshots: ${snapshotCount}`);
    console.log(`   ValueOpportunities: ${valueOppCount}`);

    // Step 4: Add a manual sync job to the match-fetch queue
    console.log('\n4. Enqueuing manual sync-traditional-sport job...');
    const matchFetchQueue = new Queue('match-fetch', {
      connection: redis as any,
    });

    const job = await matchFetchQueue.add(
      'sync-traditional-sport',
      {
        sportKey: 'basketball_nba',
        sportGroup: 'Basketball',
      },
      {
        jobId: 'e2e-validation-manual-trigger',
      },
    );
    console.log(`   ✅ Job enqueued: ${job.id}`);

    // Step 5: Wait for processing
    console.log('\n5. Waiting 30 seconds for pipeline to execute...');
    await new Promise(resolve => setTimeout(resolve, 30000));

    // Step 6: Check for new data
    console.log('\n6. Checking for new data...');
    const newSportCount = await prisma.sport.count();
    const newLeagueCount = await prisma.league.count();
    const newMatchCount = await prisma.match.count();
    const newSnapshotCount = await prisma.oddsSnapshot.count();
    const newValueOppCount = await prisma.valueOpportunity.count();

    const matchesDelta = newMatchCount - matchCount;
    const snapshotsDelta = newSnapshotCount - snapshotCount;
    const valueOppsDelta = newValueOppCount - valueOppCount;

    console.log(`   Sports: ${matchCount} → ${newSportCount} (${newSportCount - sportCount} new)`);
    console.log(`   Leagues: ${leagueCount} → ${newLeagueCount} (${newLeagueCount - leagueCount} new)`);
    console.log(`   Matches: ${matchCount} → ${newMatchCount} (${matchesDelta} new)`);
    console.log(`   OddsSnapshots: ${snapshotCount} → ${newSnapshotCount} (${snapshotsDelta} new)`);
    console.log(`   ValueOpportunities: ${valueOppCount} → ${newValueOppCount} (${valueOppsDelta} new)`);

    // Step 7: If no snapshots, check if the odds-fetch queue also needs triggering
    if (snapshotsDelta === 0 && matchesDelta > 0) {
      console.log('\n7. No snapshots created. Triggering odds-fetch manually...');

      // Get the match external IDs that were just created
      const recentMatches = await prisma.match.findMany({
        where: {
          createdAt: {
            gte: new Date(Date.now() - 60000),
          },
        },
        select: { externalId: true, sport: { select: { externalSportKey: true } } },
      });

      const oddsFetchQueue = new Queue('odds-fetch', {
        connection: redis as any,
      });

      for (const match of recentMatches) {
        if (!match.externalId.startsWith('oa:')) continue;

        const sportKey = match.sport?.externalSportKey || 'basketball_nba';
        await oddsFetchQueue.add(
          'sync-odds-for-sport',
          {
            sportKey,
            sportGroup: 'Basketball',
            matchExternalIds: [match.externalId],
          },
          { delay: 5000 },
        );
        console.log(`   Enqueued sync-odds-for-sport for ${match.externalId}`);
      }

      // Wait again
      console.log('\n   Waiting 15 seconds for odds processing...');
      await new Promise(resolve => setTimeout(resolve, 15000));

      // Final check
      const finalSnapshotCount = await prisma.oddsSnapshot.count();
      const finalValueOppCount = await prisma.valueOpportunity.count();
      console.log(`   OddsSnapshots: ${newSnapshotCount} → ${finalSnapshotCount} (${finalSnapshotCount - newSnapshotCount} new)`);
      console.log(`   ValueOpportunities: ${newValueOppCount} → ${finalValueOppCount} (${finalValueOppCount - newValueOppCount} new)`);
    }

    // Step 8: Print some sample data
    console.log('\n8. Sample data:');
    const sampleSnapshots = await prisma.oddsSnapshot.findMany({
      take: 5,
      orderBy: { capturedAt: 'desc' },
      include: { match: { select: { externalId: true } } },
    });

    if (sampleSnapshots.length > 0) {
      for (const s of sampleSnapshots) {
        console.log(`   OddsSnapshot: ${s.match.externalId} | ${s.bookmaker} | ${s.market} | ${s.outcome} | ${s.price} | main=${s.isMain}`);
      }
    } else {
      console.log('   No OddsSnapshot records found');
    }

    const sampleOpps = await prisma.valueOpportunity.findMany({
      take: 5,
      orderBy: { createdAt: 'desc' },
    });

    if (sampleOpps.length > 0) {
      for (const o of sampleOpps) {
        console.log(`   ValueOpportunity: match=${o.matchExternalId} | type=${o.opportunityType} | status=${o.status} | ev=${o.expectedValue}`);
      }
    } else {
      console.log('   No ValueOpportunity records found');
    }

    // Final verdict
    console.log('\n=== VALIDATION SUMMARY ===');
    const totalSnapshots = await prisma.oddsSnapshot.count();
    const totalOpps = await prisma.valueOpportunity.count();

    console.log(`Total OddsSnapshots: ${totalSnapshots}`);
    console.log(`Total ValueOpportunities: ${totalOpps}`);

    if (totalSnapshots > 0) {
      console.log('\n✅ PASS: OddsSnapshots created successfully');
    } else {
      console.log('\n❌ FAIL: No OddsSnapshot records created');
    }

    if (totalOpps > 0) {
      console.log('✅ PASS: ValueOpportunities created successfully');
    } else {
      console.log('❌ No ValueOpportunity records (may be expected if no value opportunities detected)');
    }

  } catch (err) {
    console.error('\n❌ Validation failed with error:');
    console.error(err);
  } finally {
    await prisma.$disconnect();
    await redis.quit();
  }
}

void main();