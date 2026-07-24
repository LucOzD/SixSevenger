# recommender.py
# Posts as points in a fixed-dimensional hashed vector space.
# Categories are discovered DYNAMICALLY via online threshold clustering:
# each new post either joins the most similar existing category, or — if it
# is not similar enough to any of them — spawns a brand new category.
# Nothing about the number or identity of categories is hard-coded; they
# grow organically as new kinds of posts appear.
# Category topology: knows which categories are similar and HOW they differ.
# User profiling: builds interest vector from interactions, then finds
# not just liked categories but similar ones weighted by relevance.

import re
import pickle
import os
import numpy as np
from collections import defaultdict, Counter
from sklearn.feature_extraction.text import HashingVectorizer, ENGLISH_STOP_WORDS


class CategoryTopology:
    """
    Builds and maintains a map of how all discovered categories
    relate to each other in vector space.

    For each pair of categories it stores:
      - similarity:   cosine similarity of their centroids (0-1)
      - diff_dims:    the top TF-IDF dimensions (words) that most
                      distinguish the two categories from each other
      - diff_vector:  the normalised difference vector, used for
                      directional recommendations

    This lets the recommender answer:
      "The user likes category A. Which other categories are similar,
       and in what way do they differ — so we only surface the ones
       that differ in directions the user has not rejected?"
    """

    def __init__(self):
        self.centroids    = {}   # cat_id -> mean vector of all posts in that category
        self.similarities = {}   # (cat_a, cat_b) -> float
        self.diff_dims    = {}   # (cat_a, cat_b) -> [top distinguishing words]
        self.diff_vectors = {}   # (cat_a, cat_b) -> normalised diff vector

        self.n_posts = defaultdict(int)

    def update(self, cat_id, post_vector):
        """
        Update the centroid for a category with a new post vector.
        Uses an online mean so we never store all post vectors.
        """
        n = self.n_posts[cat_id]
        if cat_id not in self.centroids:
            self.centroids[cat_id] = post_vector.copy()
        else:
            self.centroids[cat_id] = (
                self.centroids[cat_id] * n + post_vector
            ) / (n + 1)
        self.n_posts[cat_id] += 1

    def rebuild_relations(self, feature_names):
        """
        Recompute all pairwise relationships between category centroids.
        Called every N posts rather than on every update.
        """
        cats = list(self.centroids.keys())
        if len(cats) < 2:
            return

        for i, cat_a in enumerate(cats):
            for cat_b in cats[i + 1:]:
                vec_a = self.centroids[cat_a]
                vec_b = self.centroids[cat_b]

                # Cosine similarity between centroids
                dot  = float(np.dot(vec_a, vec_b))
                norm = float(np.linalg.norm(vec_a) * np.linalg.norm(vec_b))
                sim  = dot / norm if norm > 0 else 0.0

                self.similarities[(cat_a, cat_b)] = sim
                self.similarities[(cat_b, cat_a)] = sim

                # Difference vector: direction FROM cat_b TO cat_a
                diff = vec_a - vec_b
                diff_norm = np.linalg.norm(diff)
                diff_n = diff / diff_norm if diff_norm > 0 else diff

                self.diff_vectors[(cat_a, cat_b)] =  diff_n
                self.diff_vectors[(cat_b, cat_a)] = -diff_n

                # Words that most distinguish cat_a from cat_b
                if feature_names is not None and len(feature_names) > 0:
                    top_a_idx = diff_n.argsort()[-6:][::-1]
                    top_b_idx = (-diff_n).argsort()[-6:][::-1]
                    self.diff_dims[(cat_a, cat_b)] = [
                        str(feature_names[i]) for i in top_a_idx if i < len(feature_names)
                    ]
                    self.diff_dims[(cat_b, cat_a)] = [
                        str(feature_names[i]) for i in top_b_idx if i < len(feature_names)
                    ]

    def get_similar_categories(self, cat_id, n=5, min_similarity=0.01):
        """Return categories similar to cat_id. Always recomputes if needed."""
        # If this category has no similarity data yet, force a rebuild
        has_data = any(a == cat_id for (a, _) in self.similarities)
        if not has_data and len(self.centroids) >= 2:
            self.rebuild_relations(None)

        scores = {}
        for (a, b), sim in self.similarities.items():
            if a == cat_id and sim >= min_similarity:
                scores[b] = sim
        return sorted(scores.items(), key=lambda x: x[1], reverse=True)[:n]

    def describe_relationship(self, cat_a, cat_b):
        sim   = self.similarities.get((cat_a, cat_b), 0)
        words = self.diff_dims.get((cat_a, cat_b), [])
        return {'similarity': round(sim, 3), 'cat_a_distinctive_words': words}


import nltk
nltk.download('vader_lexicon', quiet=True)
from nltk.sentiment.vader import SentimentIntensityAnalyzer


class SentimentLexicon:
    """
    Sentiment analysis using NLTK's VADER (Valence Aware Dictionary and
    sEntiment Reasoner). VADER is specifically tuned for social media text —
    handles slang, capitalization, punctuation emphasis, and emoji.

    Returns the compound score: a normalized value from -1.0 (most negative)
    to +1.0 (most positive).
    """

    def __init__(self):
        self._analyzer = SentimentIntensityAnalyzer()

    def score(self, text):
        """Return VADER compound score in [-1.0, 1.0]."""
        scores = self._analyzer.polarity_scores(text)
        return scores['compound']

    def full_scores(self, text):
        """Return the full VADER breakdown: neg, neu, pos, compound."""
        return self._analyzer.polarity_scores(text)

    @staticmethod
    def label(compound):
        """Convert compound score to a simple label."""
        if compound >= 0.05:
            return 'positive'
        elif compound <= -0.05:
            return 'negative'
        return 'neutral'


class PostAnalyser:
    """
    Embeds posts into a fixed-dimensional hashed vector space and assigns
    them to DYNAMICALLY discovered categories.

    There is no fixed number of categories. Clustering is done online with
    a similarity threshold (a "leader" / nearest-centroid scheme):

      - Vectorise the post.
      - Find the existing category whose centroid is most similar (cosine).
      - If that similarity clears `similarity_threshold`, the post joins
        that category and nudges its centroid.
      - Otherwise the post is different enough to be its own thing, so a
        brand new category is created on the spot.

    As new topics appear in the data, new categories appear automatically.
    A HashingVectorizer is used (instead of TF-IDF) so the vector space
    never needs re-fitting and unseen words are handled gracefully.
    """

    def __init__(self, similarity_threshold=0.12, n_features=4096,
                 rebuild_every=25, min_posts_for_category=2):
        self.n_features = n_features
        self.vectorizer = HashingVectorizer(
            n_features=n_features,
            stop_words='english',
            ngram_range=(1, 2),
            alternate_sign=False,
            norm='l2',
        )
        self.similarity_threshold = similarity_threshold
        self.min_posts_for_category = min_posts_for_category
        self.rebuild_every        = rebuild_every

        self.topology       = CategoryTopology()   # owns the centroids
        self.category_words  = {}                   # cat_id -> [top words]
        self._word_counts    = defaultdict(Counter) # cat_id -> word frequencies
        self._next_id        = 0
        self._post_count     = 0

        # Pending posts: vectors that didn't match any existing category.
        # They wait here until enough similar posts accumulate to form
        # a real category (min_posts_for_category).
        self._pending = []  # [(post_id, dense_vector, cleaned_text)]

        # Basic sentiment lexicon
        self.sentiment = SentimentLexicon()

        # Track average sentiment per category (running mean)
        self.category_sentiment = {}  # cat_id -> float (-1 to 1)
        self._sentiment_counts  = defaultdict(int)

    # ------------------------------------------------------------------
    def _clean(self, text):
        text = text.lower()
        text = re.sub(r'http\S+', '', text)
        text = re.sub(r'@\w+', '', text)
        # Extract hashtags before cleaning — they get triple weight
        hashtags = re.findall(r'#([a-z0-9_]+)', text)
        text = re.sub(r'[^a-z0-9#\s]', ' ', text)
        # Repeat hashtags 3x to give them more significance than regular words
        if hashtags:
            text = text + ' ' + ' '.join(hashtags * 3)
        return text.strip()

    def extract_hashtags(self, text):
        """Extract hashtag strings from raw post text."""
        return re.findall(r'#([a-zA-Z0-9_]+)', text.lower())

    def _vectorize(self, cleaned):
        sparse = self.vectorizer.transform([cleaned])
        dense  = np.asarray(sparse.todense()).flatten()
        sparse_dict = {int(i): float(v) for i, v in zip(sparse.indices, sparse.data)}
        return dense, sparse_dict

    def _nearest_category(self, dense):
        """Return (cat_id, cosine_similarity) of the closest centroid."""
        best_cat, best_sim = None, -1.0
        dn = np.linalg.norm(dense)
        if dn == 0:
            return None, -1.0
        for cat_id, centroid in self.topology.centroids.items():
            cn = np.linalg.norm(centroid)
            if cn == 0:
                continue
            sim = float(np.dot(dense, centroid) / (dn * cn))
            if sim > best_sim:
                best_sim, best_cat = sim, cat_id
        return best_cat, best_sim

    # ------------------------------------------------------------------
    def add_post(self, post_id, text, author_context=None):
        """
        Embed the post, assign it to an existing category or buffer it
        in the pending pool until enough similar posts accumulate.

        author_context (optional): {
            'avg_sentiment': float,    # average sentiment of author's other posts
            'top_categories': [int],   # categories the author posts in most
        }
        When a post's sentiment is ambiguous (near 0), the author's historical
        sentiment is blended in. Also used to bias category assignment toward
        categories the author already posts in.

        Returns (category_id, sparse_vector_dict, sentiment_score).
        category_id is -1 if the post is still pending.
        """
        cleaned = self._clean(text)
        dense, sparse_dict = self._vectorize(cleaned)
        raw_sent = self.sentiment.score(text)

        # Blend author context into sentiment when the post itself is ambiguous.
        # VADER compound near 0 means it can't tell — lean on author history.
        sent_score = raw_sent
        if author_context and abs(raw_sent) < 0.3:
            author_avg = author_context.get('avg_sentiment', 0)
            # Blend: 40% author history, 60% post's own score when ambiguous
            blend_weight = 0.4 * (1 - abs(raw_sent) / 0.3)  # stronger blend the more neutral
            sent_score = raw_sent * (1 - blend_weight) + author_avg * blend_weight

        best_cat, best_sim = self._nearest_category(dense)

        # If the post is borderline (similarity close to threshold) and the
        # author already posts in a specific category, bias toward that category.
        if author_context and best_cat is not None:
            author_cats = author_context.get('top_categories', [])
            if best_cat in author_cats:
                # Lower the bar slightly — author consistency is a signal
                effective_threshold = self.similarity_threshold * 0.8
            else:
                effective_threshold = self.similarity_threshold
        else:
            effective_threshold = self.similarity_threshold

        if best_cat is not None and best_sim >= effective_threshold:
            # Matches an existing category — assign it
            cat_id = best_cat
            self.topology.update(cat_id, dense)
            self._learn_words(cat_id, cleaned)
            self._update_category_sentiment(cat_id, sent_score)
        else:
            # Doesn't match any category. Add to pending and try to
            # form a new category from the pending pool.
            self._pending.append((post_id, dense, cleaned))
            cat_id = self._try_form_category_from_pending()

            if cat_id == -1:
                # Still pending — not enough similar posts yet
                self._post_count += 1
                return -1, sparse_dict, sent_score

        self._post_count += 1
        if self._post_count % self.rebuild_every == 0:
            self.topology.rebuild_relations(None)

        return cat_id, sparse_dict, sent_score

    def _try_form_category_from_pending(self):
        """
        Check if any cluster of pending posts has reached
        min_posts_for_category. If so, create a real category
        from them, then absorb any other pending posts that now match.
        """
        if len(self._pending) < self.min_posts_for_category:
            return -1

        # Try to cluster pending posts: for each pending post,
        # find how many other pending posts are similar to it.
        n = len(self._pending)
        for i in range(n):
            _, vec_i, _ = self._pending[i]
            ni = np.linalg.norm(vec_i)
            if ni == 0:
                continue

            cluster_indices = [i]
            for j in range(n):
                if j == i:
                    continue
                _, vec_j, _ = self._pending[j]
                nj = np.linalg.norm(vec_j)
                if nj == 0:
                    continue
                sim = float(np.dot(vec_i, vec_j) / (ni * nj))
                if sim >= self.similarity_threshold:
                    cluster_indices.append(j)

            if len(cluster_indices) >= self.min_posts_for_category:
                # Form a new category from this cluster
                cat_id = self._next_id
                self._next_id += 1

                for idx in cluster_indices:
                    _, vec, cleaned = self._pending[idx]
                    self.topology.update(cat_id, vec)
                    self._learn_words(cat_id, cleaned)
                    # Score sentiment from the raw-ish cleaned text
                    self._update_category_sentiment(cat_id, self.sentiment.score(cleaned))

                # Remove clustered posts from pending (in reverse order)
                for idx in sorted(cluster_indices, reverse=True):
                    self._pending.pop(idx)

                # Rebuild all pairwise similarities so the new category
                # immediately knows what it's similar to
                self.topology.rebuild_relations(None)

                # Now re-check remaining pending posts against the new category
                self._absorb_pending_into_categories()

                return cat_id

        return -1

    def _absorb_pending_into_categories(self):
        """
        After forming a new category, check if any remaining pending
        posts now match an existing category. Absorb them if so.
        """
        still_pending = []
        for post_id, dense, cleaned in self._pending:
            best_cat, best_sim = self._nearest_category(dense)
            if best_cat is not None and best_sim >= self.similarity_threshold:
                self.topology.update(best_cat, dense)
                self._learn_words(best_cat, cleaned)
            else:
                still_pending.append((post_id, dense, cleaned))
        self._pending = still_pending

    # ------------------------------------------------------------------
    def _learn_words(self, cat_id, cleaned):
        counts = self._word_counts[cat_id]
        for w in cleaned.split():
            if len(w) > 1 and w not in ENGLISH_STOP_WORDS:
                counts[w] += 1
        self.category_words[cat_id] = [w for w, _ in counts.most_common(10)]

    def _update_category_sentiment(self, cat_id, sent_score):
        """Online running average of sentiment for a category."""
        n = self._sentiment_counts[cat_id]
        if cat_id not in self.category_sentiment:
            self.category_sentiment[cat_id] = sent_score
        else:
            self.category_sentiment[cat_id] = (
                self.category_sentiment[cat_id] * n + sent_score
            ) / (n + 1)
        self._sentiment_counts[cat_id] += 1

    def get_category_sentiment(self, cat_id):
        """Return avg sentiment for a category. 0.0 if unknown."""
        return self.category_sentiment.get(cat_id, 0.0)

    def describe(self, cat_id):
        words = self.category_words.get(int(cat_id), [])
        return ', '.join(words) if words else f'category_{cat_id}'

    def distinctive_words(self, cat_a, cat_b, n=6):
        """Words common in cat_a but not prominent in cat_b."""
        a_words = self.category_words.get(int(cat_a), [])
        b_words = set(self.category_words.get(int(cat_b), []))
        return [w for w in a_words if w not in b_words][:n]

    @property
    def num_categories(self):
        return len(self.topology.centroids)

    def get_similar_posts(self, post_vec, candidates, top_n=10):
        """
        post_vec and each candidate may be either a dense list or a
        sparse {index: value} dict. Returns [(post_id, similarity), ...].
        """
        def to_dense(v):
            if isinstance(v, dict):
                arr = np.zeros(self.n_features)
                for i, val in v.items():
                    arr[int(i)] = val
                return arr
            return np.array(v)

        target = to_dense(post_vec)
        tn = np.linalg.norm(target)
        results = []
        for pid, cand in candidates.items():
            c = to_dense(cand)
            cn = np.linalg.norm(c)
            sim = float(np.dot(target, c) / (tn * cn)) if tn > 0 and cn > 0 else 0.0
            results.append((pid, sim))
        results.sort(key=lambda x: x[1], reverse=True)
        return results[:top_n]

    def save(self, path='recommender_state.pkl'):
        with open(path, 'wb') as f:
            pickle.dump(self, f)

    @staticmethod
    def load(path='recommender_state.pkl'):
        with open(path, 'rb') as f:
            return pickle.load(f)


class UserProfiler:
    """
    Tracks each user as a weighted interest vector over categories.

    Scoring logic for ranked_categories:
    1. Direct score  — from explicit interactions (likes/comments/dislikes)
    2. Topology bonus — categories similar to liked ones get a boost
       scaled by how similar they are to the source category
    3. Topology penalty — categories similar to disliked ones lose score
    4. Directional alignment — user's aggregate interest vector is compared
       to each category centroid; categories that point in the same direction
       as the user's overall taste score higher
    5. Novelty floor — every category keeps a minimum score so discovery works
    """

    SIGNAL_WEIGHTS = {
        'like':    0.10,
        'dislike': -0.06,
        'comment': 0.07,
        'save':    0.15,
        'view':    0.02,
    }

    def __init__(self):
        self.profiles      = defaultdict(lambda: defaultdict(float))
        self.interest_vecs = {}   # user_id -> weighted sum of liked centroids
        self.dislike_vecs  = {}   # user_id -> weighted sum of disliked centroids

    def update(self, user_id, category_id, signal, category_centroid=None):
        delta = self.SIGNAL_WEIGHTS.get(signal, 0)
        self.profiles[user_id][category_id] += delta
        self.profiles[user_id][category_id] = max(
            0.0, self.profiles[user_id][category_id]
        )

        if category_centroid is not None:
            centroid = np.array(category_centroid)
            weight   = abs(delta)
            if delta > 0:
                prev = np.array(self.interest_vecs.get(user_id, centroid))
                self.interest_vecs[user_id] = (prev + centroid * weight).tolist()
            elif delta < 0:
                prev = np.array(self.dislike_vecs.get(user_id, centroid))
                self.dislike_vecs[user_id] = (prev + centroid * weight).tolist()

    def get_ranked_categories(self, user_id, topology, n=20):
        """
        Returns [(category_id, score), ...] sorted by relevance.
        Accounts for direct interest, cross-category similarity,
        dislike penalties, and directional alignment.
        """
        direct   = dict(self.profiles.get(user_id, {}))
        all_cats = set(topology.centroids.keys()) | set(direct.keys())
        scores   = {cat: direct.get(cat, 0.01) for cat in all_cats}

        # Boost categories similar to liked ones
        for liked_cat, liked_score in direct.items():
            if liked_score <= 0:
                continue
            for sim_cat, sim_score in topology.get_similar_categories(liked_cat, n=5):
                boost = liked_score * sim_score * 0.5
                scores[sim_cat] = scores.get(sim_cat, 0.01) + boost

        # Penalise categories similar to disliked ones
        for disliked_cat, disliked_score in direct.items():
            if disliked_score >= 0:
                continue
            for sim_cat, sim_score in topology.get_similar_categories(disliked_cat, n=5):
                penalty = abs(disliked_score) * sim_score * 0.3
                scores[sim_cat] = max(0.0, scores.get(sim_cat, 0.01) - penalty)

        # Directional alignment: re-weight by how close each category centroid
        # is to the user's aggregate interest direction
        if user_id in self.interest_vecs:
            interest   = np.array(self.interest_vecs[user_id])
            int_norm   = np.linalg.norm(interest)
            if int_norm > 0:
                interest_n = interest / int_norm
                for cat_id, centroid in topology.centroids.items():
                    c      = np.array(centroid)
                    c_norm = np.linalg.norm(c)
                    if c_norm > 0:
                        # Cosine alignment: -1 (opposite) to 1 (same direction)
                        alignment = float(np.dot(interest_n, c / c_norm))
                        # Rescale to 0.1–1.0 so misaligned cats still show occasionally
                        factor = max(0.1, (alignment + 1) / 2)
                        scores[cat_id] = scores.get(cat_id, 0.01) * factor

        return sorted(scores.items(), key=lambda x: x[1], reverse=True)[:n]

    def rank_from_scores(self, direct_scores, topology, collaborative=None,
                         category_sentiments=None, user_sentiment_pref=None, n=30):
        """
        Stateless ranking with sentiment awareness.

        category_sentiments: {cat_id: avg_sentiment} from the analyser.
        user_sentiment_pref: {cat_id: avg_sentiment_of_posts_user_liked_in_this_cat}
          If the user's liked posts in a category are positive, similar categories
          with negative sentiment get penalised, and vice versa.
        """
        direct = {int(k): float(v) for k, v in direct_scores.items()}
        all_cats = set(topology.centroids.keys()) | set(direct.keys())
        scores = {cat: direct.get(cat, 0.01) for cat in all_cats}

        # Collaborative signal: blend in what similar users like
        if collaborative:
            for cat, collab_score in collaborative.items():
                cat_int = int(cat)
                scores[cat_int] = scores.get(cat_int, 0.01) + float(collab_score) * 0.3

        # Build the user's aggregate interest / dislike directions from
        # the category centroids weighted by their direct scores.
        interest = None
        for cat, sc in direct.items():
            centroid = topology.centroids.get(cat)
            if centroid is None:
                continue
            vec = np.array(centroid) * sc
            interest = vec if interest is None else interest + vec

        # Boost categories similar to liked ones
        for liked_cat, liked_score in direct.items():
            if liked_score <= 0:
                continue
            for sim_cat, sim_score in topology.get_similar_categories(liked_cat, n=5):
                scores[sim_cat] = scores.get(sim_cat, 0.01) + liked_score * sim_score * 0.5

        # Penalise categories similar to disliked ones
        for disliked_cat, disliked_score in direct.items():
            if disliked_score >= 0:
                continue
            for sim_cat, sim_score in topology.get_similar_categories(disliked_cat, n=5):
                penalty = abs(disliked_score) * sim_score * 0.4
                scores[sim_cat] = scores.get(sim_cat, 0.01) - penalty

        # SENTIMENT PENALTY: if a category is topically similar to one the
        # user likes but has OPPOSITE sentiment, penalise it. E.g. user likes
        # "love geometry dash" (positive) → "hate geometry dash" (negative)
        # shares keywords but should be pushed down.
        if category_sentiments and user_sentiment_pref:
            for liked_cat, liked_score in direct.items():
                if liked_score <= 0:
                    continue
                user_sent = user_sentiment_pref.get(str(liked_cat), 0)
                if abs(user_sent) < 0.1:
                    continue  # neutral preference, skip

                for sim_cat, sim_score in topology.get_similar_categories(liked_cat, n=8):
                    cat_sent = category_sentiments.get(str(sim_cat), 0)
                    # Check if sentiments are opposite
                    # user likes positive → sim_cat is negative (or vice versa)
                    sent_diff = user_sent * cat_sent  # negative if opposite
                    if sent_diff < -0.05:
                        # Opposite sentiment on same topic — penalise proportionally
                        penalty = abs(sent_diff) * sim_score * liked_score * 0.6
                        scores[sim_cat] = scores.get(sim_cat, 0.01) - penalty

        # Directional alignment against the user's overall taste vector
        if interest is not None:
            int_norm = np.linalg.norm(interest)
            if int_norm > 0:
                interest_n = interest / int_norm
                for cat_id, centroid in topology.centroids.items():
                    c = np.array(centroid)
                    c_norm = np.linalg.norm(c)
                    if c_norm > 0:
                        alignment = float(np.dot(interest_n, c / c_norm))
                        factor = max(0.05, (alignment + 1) / 2)
                        scores[cat_id] = scores.get(cat_id, 0.01) * factor

        return sorted(scores.items(), key=lambda x: x[1], reverse=True)[:n]

    def decay_all(self, factor=0.97):
        for uid in self.profiles:
            for cat in self.profiles[uid]:
                self.profiles[uid][cat] *= factor

    def top_interests(self, user_id, n=5):
        profile = self.profiles.get(user_id, {})
        return sorted(profile.items(), key=lambda x: x[1], reverse=True)[:n]
