# serve.py
# Run alongside Node.js:  npm start  (uses concurrently)
# Or standalone:          python serve.py

import os
import json
import atexit
import numpy as np
from flask import Flask, request, jsonify
from recommender import PostAnalyser, UserProfiler, SentimentLexicon

app     = Flask(__name__)

# Model state lives in DATA_DIR so it survives restarts when deployed.
# Defaults to the current folder for local development.
DATA_DIR = os.environ.get('DATA_DIR', os.path.dirname(os.path.abspath(__file__)))
STATE    = os.path.join(DATA_DIR, 'recommender_state.pkl')

analyser = PostAnalyser.load(STATE) if os.path.exists(STATE) else PostAnalyser()
profiler = UserProfiler()

atexit.register(lambda: analyser.save(STATE))


# ------------------------------------------------------------------
# POST /categorise
# Called when a post is created.
# Returns category_id, the post's vector, and the category's words.
# ------------------------------------------------------------------
@app.route('/categorise', methods=['POST'])
def categorise():
    data    = request.json
    text    = data.get('text', '')
    post_id = data.get('post_id')
    author_context = data.get('author_context')  # optional

    cat_id, post_vec, sentiment = analyser.add_post(post_id, text, author_context=author_context)
    hashtags = analyser.extract_hashtags(text)

    # Persist periodically so newly discovered categories survive a restart
    if analyser._post_count % 25 == 0:
        analyser.save(STATE)

    return jsonify({
        'category_id':    cat_id,
        'post_vector':    post_vec,           # sparse vector, stored in SQLite
        'category_words': analyser.category_words.get(cat_id, []),
        'hashtags':       hashtags,
        'sentiment':      sentiment,
        'status':         'ok' if cat_id != -1 else 'pending',
    })


# ------------------------------------------------------------------
# POST /interact
# Called on every like, dislike, comment, save.
# Passes the category centroid so the user's directional vector updates.
# ------------------------------------------------------------------
@app.route('/interact', methods=['POST'])
def interact():
    data        = request.json
    user_id     = str(data['user_id'])
    category_id = int(data['category_id'])
    signal      = data['signal']

    # Pass the category centroid so the user's directional interest
    # vector gets updated (not just the per-category score)
    centroid = analyser.topology.centroids.get(category_id)

    profiler.update(user_id, category_id, signal, category_centroid=centroid)
    return jsonify({'ok': True})


# ------------------------------------------------------------------
# POST /ranked-categories
# Called by the feed to get personalised category scores.
# Returns [(category_id, score), ...] sorted by relevance.
# ------------------------------------------------------------------
@app.route('/ranked-categories', methods=['POST'])
def ranked_categories():
    data    = request.json
    user_id = str(data['user_id'])

    # Preferred path: Node sends fresh per-category scores computed from
    # the database (posts + likes - dislikes + comments). This makes the
    # ranking stateless and recomputed on every page refresh.
    direct_scores = data.get('direct_scores')
    collaborative = data.get('collaborative')
    user_sentiment_pref = data.get('user_sentiment_pref')

    # Build category sentiment map from the analyser
    category_sentiments = {str(k): v for k, v in analyser.category_sentiment.items()}

    if direct_scores:
        ranked = profiler.rank_from_scores(
            direct_scores, analyser.topology,
            collaborative=collaborative,
            category_sentiments=category_sentiments,
            user_sentiment_pref=user_sentiment_pref,
            n=30
        )
    else:
        ranked = profiler.get_ranked_categories(user_id, analyser.topology, n=30)

    return jsonify({'ranked': [[int(c), float(s)] for c, s in ranked]})


# ------------------------------------------------------------------
# GET /categories
# Inspect discovered topics and their relationships.
# Visit http://localhost:5001/categories in your browser.
# ------------------------------------------------------------------
@app.route('/categories', methods=['GET'])
def categories():
    out = {}
    for cat_id, words in analyser.category_words.items():
        similar = analyser.topology.get_similar_categories(cat_id, n=3)
        out[str(cat_id)] = {
            'words':        words,
            'description':  analyser.describe(cat_id),
            'post_count':   analyser.topology.n_posts.get(cat_id, 0),
            'sentiment':    SentimentLexicon.label(
                               analyser.get_category_sentiment(cat_id)
                           ),
            'sentiment_score': round(analyser.get_category_sentiment(cat_id), 3),
            'similar_to':   [
                {
                    'category':    int(sim_id),
                    'similarity':  round(sim_score, 3),
                    'differs_by':  analyser.distinctive_words(cat_id, sim_id),
                }
                for sim_id, sim_score in similar
            ],
        }
    return jsonify(out)


# ------------------------------------------------------------------
# POST /decay  — call from a daily cron job
# ------------------------------------------------------------------
@app.route('/decay', methods=['POST'])
def decay():
    profiler.decay_all()
    return jsonify({'ok': True})


# ------------------------------------------------------------------
# POST /similar-posts
# Given a post vector, find the most similar other posts.
# Used for "more like this" on a post detail page.
# ------------------------------------------------------------------
@app.route('/similar-posts', methods=['POST'])
def similar_posts():
    data       = request.json
    post_vec   = data['post_vector']
    candidates = data['candidates']   # {post_id: vector}
    top_n      = data.get('top_n', 10)

    results = analyser.get_similar_posts(post_vec, candidates, top_n=top_n)
    return jsonify({'similar': [[pid, round(score, 4)] for pid, score in results]})


if __name__ == '__main__':
    port = int(os.environ.get('RECOMMENDER_PORT', 5001))
    print(f'Recommender running on http://localhost:{port}')
    print(f'State: {"loaded" if os.path.exists(STATE) else "fresh start"}')
    print(f'Categories discovered: {analyser.num_categories}')
    print(f'Similarity threshold:  {analyser.similarity_threshold}')
    # 127.0.0.1 only — the recommender is internal, never exposed publicly.
    app.run(host='127.0.0.1', port=port)
