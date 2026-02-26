import { useEffect, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import Layout from '../components/Layout';
import LivePortfolio from '../components/LivePortfolio';
import Navigation from '../components/Navigation';
import ShinyText from '../components/ShinyText';
import CloudStatus from '../components/CloudStatus';

type Timeframe = '1D' | '1W' | '30D';

export default function Live() {
    const router = useRouter();
    const { timeframe } = router.query;
    const [initialTimeframe, setInitialTimeframe] = useState<Timeframe>('30D');
    const [ready, setReady] = useState(false);

    useEffect(() => {
        if (router.isReady) {
            if (timeframe) {
                const tf = (timeframe as string).toLowerCase();
                if (tf === '7d' || tf === '1w') setInitialTimeframe('1W');
                else if (tf === '1d') setInitialTimeframe('1D');
                else setInitialTimeframe('30D');
            }
            setReady(true);
        }
    }, [router.isReady, timeframe]);

    return (
        <>
            <Head>
                <title>Live Portfolio - TickSignals :&#41;</title>
                <meta name="description" content="View the live portfolio performance and trades" />
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
                            <div className="mt-2 sm:mt-0">
                                <CloudStatus />
                            </div>
                        </div>
                    </div>
                </div>

                {/* Tab Navigation */}
                <Navigation />

                {/* Content */}
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-16">
                    <div className="animate-slide-up">
                        {ready && <LivePortfolio initialTimeframe={initialTimeframe} />}
                    </div>
                </div>
            </Layout>
        </>
    );
}
