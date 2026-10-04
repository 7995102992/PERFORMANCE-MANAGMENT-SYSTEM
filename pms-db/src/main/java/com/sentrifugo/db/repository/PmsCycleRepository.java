package com.sentrifugo.db.repository;


import com.sentrifugo.db.entity.PmsCycleEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;

import java.util.Optional;
import java.util.UUID;

/**
 * Only the queries the PMS Cycle API genuinely needs: the organisation-scoped lookup that
 * enforces tenant isolation, the cycle-code uniqueness probe, and (via
 * {@link JpaSpecificationExecutor}) the filterable list.
 */
public interface PmsCycleRepository extends JpaRepository<PmsCycleEntity, UUID>,
        JpaSpecificationExecutor<PmsCycleEntity> {

    Optional<PmsCycleEntity> findByIdAndOrganisationId(UUID id, UUID organisationId);

    boolean existsByCycleCode(String cycleCode);
}
