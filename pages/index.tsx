import { useState, useEffect } from 'react';
import Head from 'next/head';
import { Search, BarChart3, Activity } from 'lucide-react';
import Layout from '../components/Layout';
import TickerAnalyzer from '../components/TickerAnalyzer';
import StockScreener from '../components/StockScreener';
import LivePortfolio from '../components/LivePortfolio';
import CloudStatus from '../components/CloudStatus';
import ShinyText from '../components/ShinyText';

export default function Home() {
  const [activeTab, setActiveTab] = useState('screener');

  const [selectedTicker, setSelectedTicker] = useState<string>('');
  const handleTickerClick = (ticker: string) => {
    setSelectedTicker(ticker);
    setActiveTab('analyzer');
  };

  const tabs = [
    { id: 'screener', label: 'Stock Screener', icon: BarChart3 },
    { id: 'analyzer', label: 'Ticker Analyzer', icon: Search },
    { id: 'portfolio', label: 'Live Portfolio', icon: Activity },
  ];

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
              {activeTab === 'portfolio' && (
                <div className="mt-2 sm:mt-0">
                  <CloudStatus />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mb-6">
          <div className="bg-gray-800 rounded-xl p-1 inline-flex gap-1 border border-gray-700">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-5 py-2.5 rounded-lg font-medium transition-colors text-sm ${activeTab === tab.id
                    ? 'bg-aquamarine-600 text-white'
                    : 'text-gray-400 hover:text-white hover:bg-gray-700'
                    }`}
                >
                  <Icon size={16} />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Content */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-16">
          <div className="animate-slide-up">
            {activeTab === 'screener' && <StockScreener onTickerClick={handleTickerClick} />}
            {activeTab === 'analyzer' && <TickerAnalyzer initialTicker={selectedTicker} />}
            {activeTab === 'portfolio' && <LivePortfolio />}
          </div>
        </div>
      </Layout>
    </>
  );
}