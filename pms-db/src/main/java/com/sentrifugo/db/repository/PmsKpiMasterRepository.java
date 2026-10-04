package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsKpiMasterEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;
import java.util.UUID;

public interface PmsKpiMasterRepository extends JpaRepository<PmsKpiMasterEntity, UUID> {

    /** Organisation-scoped lookup: the way to load a row without crossing tenants. */
    Optional<PmsKpiMasterEntity> findByIdAndOrganisationId(UUID id, UUID organisationId);
}
