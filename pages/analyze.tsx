import { useEffect, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import Layout from '../components/Layout';
import TickerAnalyzer from '../components/TickerAnalyzer';
import Navigation from '../components/Navigation';
import ShinyText from '../components/ShinyText';
import CloudStatus from '../components/CloudStatus';

export default function Analyze() {
    const router = useRouter();
    const { ticker } = router.query;
    const [initialTicker, setInitialTicker] = useState<string | undefined>(undefined);

    useEffect(() => {
        if (router.isReady && ticker) {
            setInitialTicker(ticker as string);
        }
    }, [router.isReady, ticker]);

    return (
        <>
            <Head>
                <title>Analyzer - TickSignals :&#41;</title>
                <meta name="description" content="Professional stock analyzer with real-time fundamental data" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
            </Head>

            <Layout>
                {/* Hero Section */}
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
                        {/* We only render the analyzer once router is ready, or without ticker if there isn't one */}
                        {router.isReady ? (
                            <TickerAnalyzer initialTicker={initialTicker} />
                        ) : (
                            <TickerAnalyzer />
                        )}
                    </div>
                </div>
            </Layout>
        </>
    );
}
