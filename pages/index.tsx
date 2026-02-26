import { useEffect, useState } from 'react';
import Head from 'next/head';
import Layout from '../components/Layout';
import StockScreener from '../components/StockScreener';
import Navigation from '../components/Navigation';
import ShinyText from '../components/ShinyText';
import CloudStatus from '../components/CloudStatus';
import { useRouter } from 'next/router';

export default function Home() {
  const router = useRouter();

  const handleTickerClick = (ticker: string) => {
    router.push(`/analyze?ticker=${ticker}`);
  };

  return (
    <>
      <Head>
        <title>TickSignals :&#41;</title>
        <meta name="description" content="Professional stock screener with real-time fundamental data and configurable filters" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" type="image/x-icon" href="/favicon.ico" />
      </Head>

      <Layout>
        {/* Hero Section + Cloud Status */}
        <div className="relative overflow-hidden w-full">
          <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
            <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between animate-fade-in">
              <h1>
                <ShinyText text="TickSignals" className="text-5xl sm:text-6xl md:text-7xl font-bold tracking-tight pb-2 text-white" speed={3} />
              </h1>
            </div>
          </div>
        </div>

        {/* Tab Navigation */}
        <Navigation />

        {/* Content */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-16">
          <div className="animate-slide-up">
            <StockScreener onTickerClick={handleTickerClick} />
          </div>
        </div>
      </Layout>
    </>
  );
}