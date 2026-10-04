package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsCompetencyMasterEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;
import java.util.UUID;

public interface PmsCompetencyMasterRepository extends JpaRepository<PmsCompetencyMasterEntity, UUID> {

    /** Organisation-scoped lookup: the way to load a row without crossing tenants. */
    Optional<PmsCompetencyMasterEntity> findByIdAndOrganisationId(UUID id, UUID organisationId);
}
