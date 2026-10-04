package com.sentrifugo.pms.service;

import com.sentrifugo.db.mapper.PmsCycleMapper;
import com.sentrifugo.db.repository.PmsCycleRepository;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Business logic for PMS cycles (screens 1.1-1.6). Every operation is scoped to the caller's organisation, which
 * always comes from the authenticated session and never from a request.
 *
 * <p>Not implemented yet because the supporting data does not exist: per-stage dates, applicability (plants,
 * departments, employment types), rating-scale existence checks, the eligibility run and notification counts.
 */
@Service
@RequiredArgsConstructor
public class PmsCycleService {

    private static final Logger log = LoggerFactory.getLogger(PmsCycleService.class);

    private static final int DEFAULT_PAGE_SIZE = 20;
    private static final int MAX_PAGE_SIZE = 100;

    private final PmsCycleRepository cycleRepository;
    private final PmsCycleMapper cycleMapper;


}
